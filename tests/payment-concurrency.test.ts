import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { processPurchase, type PurchaseOutcome } from "@/lib/payment";
import { FAKE_PSP_TEST_CARDS } from "@/lib/fake-psp";
import { NextRequest } from "next/server";

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

async function makeAnnualPlan() {
  return prisma.plan.create({
    data: { slug: "annual", name: "Annual", priceAmount: "99.99", currency: "USD", billingPeriodDays: 365, displayOrder: 3 },
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

function countByOutcome(results: PurchaseOutcome[]) {
  return results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
}

async function assertDbInvariants(userId: string) {
  const attempts = await prisma.paymentAttempt.findMany({ where: { userId } });
  const nonTerminal = attempts.filter((a) => a.status === "initiated" || a.status === "processing");
  expect(nonTerminal.length).toBeLessThanOrEqual(1);

  const succeededAttempts = attempts.filter((a) => a.status === "succeeded");
  const purchases = await prisma.purchase.findMany({ where: { userId } });
  expect(purchases.length).toBe(succeededAttempts.length);
  for (const purchase of purchases) {
    expect(succeededAttempts.some((a) => a.id === purchase.paymentAttemptId)).toBe(true);
  }
}

describe("payment concurrency — double-click / two tabs (same plan)", () => {
  it("two concurrent successful requests produce exactly one successful purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const [a, b] = await Promise.all([
      processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) }),
      processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) }),
    ]);

    const outcomes = countByOutcome([a, b]);
    expect(outcomes.succeeded ?? 0).toBe(1);
    expect((outcomes.duplicate ?? 0) + (outcomes.succeeded ?? 0)).toBe(2);

    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.paymentAttempt.count({ where: { userId: user.id, status: "succeeded" } })).toBe(1);
    await assertDbInvariants(user.id);
  });

  it("several (5) overlapping successful requests still produce exactly one successful purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) }),
      ),
    );

    const outcomes = countByOutcome(results);
    expect(outcomes.succeeded ?? 0).toBe(1);
    expect(outcomes.duplicate ?? 0).toBe(4);

    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
    await assertDbInvariants(user.id);
  });

  it("concurrent requests with the same idempotity identity (same user) represent one logical operation", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const results = await Promise.all([
      processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) }),
      processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) }),
      processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) }),
    ]);

    const succeeded = results.filter((r) => r.outcome === "succeeded");
    expect(succeeded).toHaveLength(1);

    const attemptIds = new Set(results.map((r) => r.attempt?.id).filter(Boolean));
    expect(attemptIds.size).toBe(1);

    await assertDbInvariants(user.id);
  });
});

describe("payment concurrency — retry after completion", () => {
  it("without an idempotency key, a technically-new purchase request after success is a separate operation (spec.md 13: not the required-to-block case)", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const first = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(first.outcome).toBe("succeeded");

    const second = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(second.outcome).toBe("succeeded");
    expect(await prisma.paymentAttempt.count({ where: { userId: user.id } })).toBe(2);
  });

  it("replaying the SAME idempotency key after success returns the original purchase and creates no second one", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();
    const idempotencyKey = "idem-key-replay-after-success";

    const first = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.success),
      idempotencyKey,
    });
    expect(first.outcome).toBe("succeeded");

    const replay = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.success),
      idempotencyKey,
    });
    expect(replay.outcome).toBe("succeeded");
    if (replay.outcome !== "succeeded" || first.outcome !== "succeeded") throw new Error("unreachable");
    expect(replay.purchase.id).toBe(first.purchase.id);
    expect(replay.attempt.id).toBe(first.attempt.id);

    expect(await prisma.paymentAttempt.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
  });

  it("concurrent requests sharing the same idempotency key represent one logical operation with exactly one purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();
    const idempotencyKey = "idem-key-concurrent";

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success), idempotencyKey }),
      ),
    );

    const attemptIds = new Set(results.map((r) => r.attempt?.id).filter(Boolean));
    expect(attemptIds.size).toBe(1);
    expect(await prisma.paymentAttempt.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe("payment concurrency — during processing", () => {
  it("a request arriving while the winner is still in `processing` gets a deterministic duplicate result, not a DB error", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const [winner, duplicate] = await Promise.allSettled([
      processPurchase({
        session,
        userId: user.id,
        plan,
        card: card(FAKE_PSP_TEST_CARDS.timeout),
        pspOptions: { timeoutDelayMs: 200 },
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 20));
        return processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
      })(),
    ]);

    expect(winner.status).toBe("fulfilled");
    expect(duplicate.status).toBe("fulfilled");
    if (winner.status !== "fulfilled" || duplicate.status !== "fulfilled") return;

    expect(winner.value.outcome).toBe("timed_out");
    expect(["duplicate", "timed_out"]).toContain(duplicate.value.outcome);

    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(0);
    await assertDbInvariants(user.id);
  }, 10000);
});

describe("payment concurrency — different plans", () => {
  it("concurrent requests for different plans from the same user do not both start a payment operation", async () => {
    const monthly = await makeMonthlyPlan();
    const annual = await makeAnnualPlan();
    const { session, user } = await identifiedVisitor();

    const [a, b] = await Promise.all([
      processPurchase({ session, userId: user.id, plan: monthly, card: card(FAKE_PSP_TEST_CARDS.success) }),
      processPurchase({ session, userId: user.id, plan: annual, card: card(FAKE_PSP_TEST_CARDS.success) }),
    ]);

    const outcomes = countByOutcome([a, b]);
    expect(outcomes.succeeded ?? 0).toBe(1);
    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
    await assertDbInvariants(user.id);
  });
});

describe("payment concurrency — refresh/retry during in-flight processing", () => {
  it("a retry submitted while the original is still processing does not create a second purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const original = processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.timeout),
      pspOptions: { timeoutDelayMs: 150 },
    });
    await new Promise((r) => setTimeout(r, 10));
    const retry = processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });

    const [originalResult, retryResult] = await Promise.all([original, retry]);

    expect(originalResult.outcome).toBe("timed_out");
    expect(retryResult.outcome === "duplicate" || retryResult.outcome === "timed_out").toBe(true);
    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(0);

    const finalRetry = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(finalRetry.outcome).toBe("succeeded");
    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe("payment concurrency — failure followed by retry", () => {
  it("a decline remains retryable and a subsequent legitimate retry succeeds with exactly one purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const declined = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.decline) });
    expect(declined.outcome).toBe("declined");

    const succeeded = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(succeeded.outcome).toBe("succeeded");

    expect(await prisma.paymentAttempt.count({ where: { userId: user.id } })).toBe(2);
    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
  });

  it("a timeout remains retryable and a subsequent legitimate retry succeeds with exactly one purchase", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const timedOut = await processPurchase({
      session,
      userId: user.id,
      plan,
      card: card(FAKE_PSP_TEST_CARDS.timeout),
      pspOptions: { timeoutDelayMs: 10 },
    });
    expect(timedOut.outcome).toBe("timed_out");

    const succeeded = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(succeeded.outcome).toBe("succeeded");

    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe("payment concurrency — stale initiated/processing attempts", () => {
  it("a stale non-terminal attempt does not permanently block a legitimate future payment", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const stale = await prisma.paymentAttempt.create({ data: { userId: user.id, planId: plan.id } });
    await prisma.$executeRawUnsafe(
      `UPDATE "payment_attempts" SET "updated_at" = now() - interval '5 minutes' WHERE "id" = $1`,
      stale.id,
    );

    const result = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(result.outcome).toBe("succeeded");

    const reaped = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: stale.id } });
    expect(reaped.status).toBe("errored");

    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(1);
    await assertDbInvariants(user.id);
  });

  it("a fresh (non-stale) non-terminal attempt is NOT reaped — it is treated as a real in-flight duplicate", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    const fresh = await prisma.paymentAttempt.create({ data: { userId: user.id, planId: plan.id } });

    const result = await processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) });
    expect(result.outcome).toBe("duplicate");
    if (result.outcome !== "duplicate") return;
    expect(result.attempt.id).toBe(fresh.id);

    expect(await prisma.paymentAttempt.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.purchase.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("payment concurrency — analytics under duplicate/concurrent requests", () => {
  it("one logical successful payment produces exactly one purchase_succeeded event, even with concurrent duplicates", async () => {
    const plan = await makeMonthlyPlan();
    const { session, user } = await identifiedVisitor();

    await Promise.all(
      Array.from({ length: 4 }, () =>
        processPurchase({ session, userId: user.id, plan, card: card(FAKE_PSP_TEST_CARDS.success) }),
      ),
    );

    expect(await prisma.funnelEvent.count({ where: { eventName: "purchase_succeeded", userId: user.id } })).toBe(1);
    expect(await prisma.funnelEvent.count({ where: { eventName: "purchase_attempted", userId: user.id } })).toBe(1);
  });
});
