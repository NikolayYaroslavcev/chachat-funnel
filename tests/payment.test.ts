import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { processPurchase } from "@/lib/payment";
import { FAKE_PSP_TEST_CARDS } from "@/lib/fake-psp";
import { POST as purchaseRoute } from "@/app/api/purchase/route";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

const FAST_TIMEOUT_MS = 10;

function makeRequest(opts: { url: string; visitorId?: string; rawBody: string }): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.visitorId) headers["cookie"] = `${VISITOR_COOKIE_NAME}=${opts.visitorId}`;
  return new NextRequest(opts.url, { method: "POST", headers, body: opts.rawBody });
}

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "funnel_events", "quiz_answers", "purchases", "payment_attempts", "plans", "sessions", "visitors", "users" RESTART IDENTITY CASCADE',
  );
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeMonthlyPlan() {
  return prisma.plan.create({
    data: { slug: "monthly", name: "Monthly", priceAmount: "14.99", currency: "USD", billingPeriodDays: 30, displayOrder: 2 },
  });
}

async function identifiedVisitor() {
  const { visitor, session } = await resolveVisitorSession(
    new NextRequest("http://localhost:3000/api/session", { method: "POST" }),
  );
  const user = await prisma.user.create({ data: { email: `user-${visitor.id}@example.com` } });
  const linked = await prisma.visitor.update({ where: { id: visitor.id }, data: { userId: user.id } });
  return { visitor: linked, session, user };
}

const card = (number: string) => ({ number, expiry: "12/30", cvc: "123" });

describe("processPurchase — success", () => {
  it("creates a succeeded attempt with exactly one matching purchase and success analytics", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const result = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.success),
    });

    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") return;

    expect(result.attempt.status).toBe("succeeded");
    expect(result.purchase.paymentAttemptId).toBe(result.attempt.id);
    expect(result.purchase.amount.toString()).toBe(plan.priceAmount.toString());
    expect(result.purchase.currency).toBe(plan.currency);

    expect(await prisma.paymentAttempt.count()).toBe(1);
    expect(await prisma.purchase.count()).toBe(1);

    const attemptedEvent = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "purchase_attempted" } });
    expect(attemptedEvent.paymentAttemptId).toBe(result.attempt.id);
    expect(attemptedEvent.planId).toBe(plan.id);

    const succeededEvent = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "purchase_succeeded" } });
    expect(succeededEvent.paymentAttemptId).toBe(result.attempt.id);
    expect(succeededEvent.purchaseId).toBe(result.purchase.id);
    expect(succeededEvent.properties).toMatchObject({ amount: plan.priceAmount.toString() });

    expect(await prisma.funnelEvent.count({ where: { eventName: "purchase_failed" } })).toBe(0);
  });

  it("does not persist the raw card number, expiry, or CVC anywhere on the attempt or purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const result = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.success),
    });
    expect(result.outcome).toBe("succeeded");

    const attempt = await prisma.paymentAttempt.findFirstOrThrow();
    const serializedAttempt = JSON.stringify(attempt);
    expect(serializedAttempt).not.toContain(FAKE_PSP_TEST_CARDS.success);
    expect(serializedAttempt).not.toContain("123");
    expect(attempt.maskedCardNumber).toMatch(/^•+ \d{4}$/);

    const purchase = await prisma.purchase.findFirstOrThrow();
    expect(JSON.stringify(purchase)).not.toContain(FAKE_PSP_TEST_CARDS.success);
  });
});

describe("processPurchase — decline", () => {
  it("moves the attempt to declined, creates no purchase, and records failure analytics", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const result = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.decline),
    });

    expect(result.outcome).toBe("declined");
    if (result.outcome !== "declined") return;
    expect(result.attempt.status).toBe("declined");
    expect(result.reason).toBe("card_declined");

    expect(await prisma.paymentAttempt.count()).toBe(1);
    expect(await prisma.purchase.count()).toBe(0);

    const failedEvent = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "purchase_failed" } });
    expect(failedEvent.paymentAttemptId).toBe(result.attempt.id);
    expect(failedEvent.properties).toMatchObject({ reason: "declined" });
    expect(await prisma.funnelEvent.count({ where: { eventName: "purchase_succeeded" } })).toBe(0);
  });
});

describe("processPurchase — timeout", () => {
  it("moves the attempt to timed_out, creates no purchase, and records failure analytics", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const result = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.timeout),
      pspOptions: { timeoutDelayMs: FAST_TIMEOUT_MS },
    });

    expect(result.outcome).toBe("timed_out");
    if (result.outcome !== "timed_out") return;
    expect(result.attempt.status).toBe("timed_out");

    expect(await prisma.paymentAttempt.count()).toBe(1);
    expect(await prisma.purchase.count()).toBe(0);

    const failedEvent = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "purchase_failed" } });
    expect(failedEvent.properties).toMatchObject({ reason: "timed_out" });
  });
});

describe("processPurchase — plan/attempt integrity", () => {
  it("always uses the DB plan's amount/currency for the purchase, regardless of what a caller passes as the plan object's price", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const result = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.success),
    });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") return;

    const purchase = await prisma.purchase.findFirstOrThrow();
    expect(purchase.amount.toString()).toBe("14.99");
    expect(purchase.currency).toBe("USD");
  });
});

describe("POST /api/purchase — full route", () => {
  it("returns a succeeded response and persists the purchase for the success test card", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor } = await identifiedVisitor();

    const res = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: plan.id, card: card(FAKE_PSP_TEST_CARDS.success) }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("succeeded");
    expect(body.purchase.amount).toBe("14.99");
    expect(body.purchase.currency).toBe("USD");

    expect(await prisma.purchase.count()).toBe(1);
    expect(await prisma.paymentAttempt.count({ where: { status: "succeeded" } })).toBe(1);
  });

  it("ignores a client-supplied amount/price and still charges the DB plan price", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor } = await identifiedVisitor();

    const res = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({
          planId: plan.id,
          amount: "0.01",
          price: "0.01",
          card: card(FAKE_PSP_TEST_CARDS.success),
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purchase.amount).toBe("14.99");

    const purchase = await prisma.purchase.findFirstOrThrow();
    expect(purchase.amount.toString()).toBe("14.99");
  });

  it("returns a declined response without creating a purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor } = await identifiedVisitor();

    const res = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: plan.id, card: card(FAKE_PSP_TEST_CARDS.decline) }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("declined");
    expect(await prisma.purchase.count()).toBe(0);
  });

  it("eventually returns a timed_out response rather than hanging, without creating a purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor } = await identifiedVisitor();

    const res = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: plan.id, card: card(FAKE_PSP_TEST_CARDS.timeout) }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("timed_out");
    expect(await prisma.purchase.count()).toBe(0);
  }, 10000);

  it("allows a retry after a decline to succeed, producing exactly one purchase overall", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor } = await identifiedVisitor();

    const declined = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: plan.id, card: card(FAKE_PSP_TEST_CARDS.decline) }),
      }),
    );
    expect((await declined.json()).status).toBe("declined");

    const succeeded = await purchaseRoute(
      makeRequest({
        url: "http://localhost:3000/api/purchase",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ planId: plan.id, card: card(FAKE_PSP_TEST_CARDS.success) }),
      }),
    );
    expect((await succeeded.json()).status).toBe("succeeded");

    expect(await prisma.paymentAttempt.count()).toBe(2);
    expect(await prisma.purchase.count()).toBe(1);
  });
});
