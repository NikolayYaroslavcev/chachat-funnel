import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { processPurchase } from "@/lib/payment";
import { FAKE_PSP_TEST_CARDS } from "@/lib/fake-psp";
import { getSucceededPurchase, resolveInstallAccess } from "@/lib/install";
import { POST as screenViewRoute } from "@/app/api/screen-view/route";
import { VISITOR_COOKIE_NAME } from "@/lib/cookies";

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

describe("resolveInstallAccess", () => {
  it("allows access for a user with a succeeded purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor, session, user } = await identifiedVisitor();
    const result = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(result.outcome).toBe("succeeded");

    const access = await resolveInstallAccess(visitor.id);
    expect(access.status).toBe("allowed");
    if (access.status !== "allowed") return;
    expect(access.purchase.planName).toBe("Monthly");
    expect(access.purchase.userEmail).toBe(user.email);
  });

  it("redirects to / when there is no visitor id at all", async () => {
    const access = await resolveInstallAccess(undefined);
    expect(access).toEqual({ status: "redirect", to: "/" });
  });

  it("redirects to / for an unknown/tampered visitor id", async () => {
    const access = await resolveInstallAccess("not-a-real-visitor-id");
    expect(access).toEqual({ status: "redirect", to: "/" });
  });

  it("redirects to / for a visitor that has never identified with an email", async () => {
    const { visitor } = await resolveVisitorSession(
      new NextRequest("http://localhost:3000/api/session", { method: "POST" }),
    );
    const access = await resolveInstallAccess(visitor.id);
    expect(access).toEqual({ status: "redirect", to: "/" });
  });

  it("redirects to /paywall for an identified user with no purchase at all", async () => {
    const { visitor } = await identifiedVisitor();
    const access = await resolveInstallAccess(visitor.id);
    expect(access).toEqual({ status: "redirect", to: "/paywall" });
  });

  it("redirects to /paywall for a user with only a declined payment", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor, session, user } = await identifiedVisitor();
    await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.decline) });

    const access = await resolveInstallAccess(visitor.id);
    expect(access).toEqual({ status: "redirect", to: "/paywall" });
  });

  it("redirects to /paywall for a user with only a timed-out payment", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor, session, user } = await identifiedVisitor();
    await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.timeout),
      pspOptions: { timeoutDelayMs: 10 },
    });

    const access = await resolveInstallAccess(visitor.id);
    expect(access).toEqual({ status: "redirect", to: "/paywall" });
  });

  it("keeps access allowed across repeated calls (refresh) without creating another purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor, session, user } = await identifiedVisitor();
    await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });

    const first = await resolveInstallAccess(visitor.id);
    const second = await resolveInstallAccess(visitor.id);
    expect(first.status).toBe("allowed");
    expect(second.status).toBe("allowed");
    expect(await prisma.purchase.count()).toBe(1);
  });

  it("allows access after a decline followed by a successful retry, with exactly one purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor, session, user } = await identifiedVisitor();
    const declined = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.decline) });
    expect(declined.outcome).toBe("declined");
    const succeeded = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(succeeded.outcome).toBe("succeeded");

    const access = await resolveInstallAccess(visitor.id);
    expect(access.status).toBe("allowed");
    expect(await prisma.purchase.count()).toBe(1);
    expect(await prisma.paymentAttempt.count()).toBe(2);
  });
});

describe("getSucceededPurchase", () => {
  it("returns null for a user with no purchase", async () => {
    const { user } = await identifiedVisitor();
    expect(await getSucceededPurchase(user.id)).toBeNull();
  });
});

describe("POST /api/screen-view — install_viewed", () => {
  it("records install_viewed with the server-looked-up purchase id for a purchased visitor", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor, session, user } = await identifiedVisitor();
    const result = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") return;

    const res = await screenViewRoute(
      makeRequest({
        url: "http://localhost:3000/api/screen-view",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ screen: "install" }),
      }),
    );
    expect(res.status).toBe(200);

    const installViewed = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "install_viewed" } });
    expect(installViewed.purchaseId).toBe(result.purchase.id);
    expect(installViewed.userId).toBe(user.id);

    const screenView = await prisma.funnelEvent.findFirstOrThrow({ where: { eventName: "screen_view" } });
    expect(screenView.properties).toMatchObject({ screen: "install" });
  });

  it("does not record install_viewed for a visitor without a succeeded purchase", async () => {
    const { visitor } = await identifiedVisitor();

    const res = await screenViewRoute(
      makeRequest({
        url: "http://localhost:3000/api/screen-view",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ screen: "install" }),
      }),
    );
    expect(res.status).toBe(200);

    expect(await prisma.funnelEvent.count({ where: { eventName: "install_viewed" } })).toBe(0);
    expect(await prisma.funnelEvent.count({ where: { eventName: "screen_view" } })).toBe(1);
  });

  it("does not create a duplicate purchase when the install screen is viewed twice (refresh)", async () => {
    const plan = await makeMonthlyPlan();
    const { visitor, session, user } = await identifiedVisitor();
    await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });

    await screenViewRoute(
      makeRequest({
        url: "http://localhost:3000/api/screen-view",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ screen: "install" }),
      }),
    );
    await screenViewRoute(
      makeRequest({
        url: "http://localhost:3000/api/screen-view",
        visitorId: visitor.id,
        rawBody: JSON.stringify({ screen: "install" }),
      }),
    );

    expect(await prisma.funnelEvent.count({ where: { eventName: "install_viewed" } })).toBe(2);
    expect(await prisma.purchase.count()).toBe(1);
  });
});
