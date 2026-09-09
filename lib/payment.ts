import { Prisma, type PaymentAttempt, type Plan, type Purchase, type Session } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordFunnelEvent, type FunnelEventContext } from "@/lib/analytics";
import { processFakePayment } from "@/lib/fake-psp";

export type CardInput = { number: string; expiry: string; cvc: string };

// Discriminated result of one basic Purchase request (spec.md 11, 13).
// Every branch carries the attempt so callers can read its final id/status
// without a second query. `duplicate` (stage 12) means this request did not
// start a new payment operation at all — the user already had one in
// flight, so this call joined that existing operation instead.
export type PurchaseOutcome =
  | { outcome: "succeeded"; attempt: PaymentAttempt; purchase: Purchase }
  | { outcome: "declined"; attempt: PaymentAttempt; reason: "card_declined" | "unsupported_test_card" }
  | { outcome: "timed_out"; attempt: PaymentAttempt }
  | { outcome: "errored"; attempt: PaymentAttempt | null }
  | { outcome: "duplicate"; attempt: PaymentAttempt };

// How long a non-terminal (initiated/processing) attempt can go without a
// status change before it's treated as abandoned rather than genuinely
// in-flight (spec.md 13's "one logical payment operation" join logic below
// only applies to attempts that are actually still alive). Comfortably
// above the fake PSP's worst case (FAKE_PSP_TIMEOUT_DELAY_MS = 3s) plus
// processing overhead — real in-flight requests never approach it, so this
// only ever fires for attempts a crashed/interrupted request left behind.
const STALE_ACTIVE_ATTEMPT_MS = 60_000;

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Maps a user's existing payment_attempt to the PurchaseOutcome a fresh
// request should see when it joins that attempt instead of starting a new
// one (spec.md 13: return "текущий или итоговый статус" of the existing
// operation). Covers every status, not just non-terminal ones — a request
// can also land here after the winning concurrent request already finished.
async function outcomeForExistingAttempt(attempt: PaymentAttempt): Promise<PurchaseOutcome> {
  switch (attempt.status) {
    case "succeeded": {
      const purchase = await prisma.purchase.findUniqueOrThrow({ where: { paymentAttemptId: attempt.id } });
      return { outcome: "succeeded", attempt, purchase };
    }
    case "declined":
      return {
        outcome: "declined",
        attempt,
        reason: attempt.resultMessage === "unsupported_test_card" ? "unsupported_test_card" : "card_declined",
      };
    case "timed_out":
      return { outcome: "timed_out", attempt };
    case "errored":
      return { outcome: "errored", attempt };
    case "initiated":
    case "processing":
      return { outcome: "duplicate", attempt };
  }
}

// Starts the one payment_attempt this request is responsible for — or joins
// an existing operation instead of creating a second one, in either of two
// cases (spec.md 13):
//
// 1. An attempt already exists for this exact `idempotencyKey` (any
//    status, including terminal) — this request is a repeat of one
//    specific earlier request (double-click, refresh-resume, or a client
//    retry after a network failure that actually reached the server), not
//    a new logical operation. Only meaningful when the caller supplies a
//    key; a request with no key can never match one this way.
// 2. The user already has a non-terminal (initiated/processing) attempt
//    for *any* key/plan — "one logical payment operation" is defined
//    per-user, not per-request/per-plan/per-tab, so a second tab or a
//    plain duplicate click joins it even without a shared key.
//
// The read-then-write below is a fast path for the common case, not the
// actual guarantee: the two unique indexes on payment_attempts
// (`payment_attempts_one_active_per_user` and the (user_id,
// idempotency_key) index) are what make this safe under real concurrency —
// two requests racing past the reads above both attempt the insert, and
// the loser's unique-violation is caught and turned into the same "join
// the existing operation" result, never a 500.
//
// A stale non-terminal attempt (older than STALE_ACTIVE_ATTEMPT_MS — i.e.
// abandoned by an interrupted request, not genuinely in flight) is reaped
// to `errored` first so it stops blocking this user's future legitimate
// payments, then a fresh attempt is created normally.
async function beginAttempt(
  eventContext: FunnelEventContext,
  userId: string,
  plan: Plan,
  idempotencyKey: string | undefined,
): Promise<{ attempt: PaymentAttempt; created: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      if (idempotencyKey) {
        const byKey = await tx.paymentAttempt.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
        });
        if (byKey) return { attempt: byKey, created: false };
      }

      const existing = await tx.paymentAttempt.findFirst({
        where: { userId, status: { in: ["initiated", "processing"] } },
      });

      if (existing) {
        const isStale = Date.now() - existing.updatedAt.getTime() > STALE_ACTIVE_ATTEMPT_MS;
        if (!isStale) {
          return { attempt: existing, created: false };
        }

        await tx.paymentAttempt.update({
          where: { id: existing.id },
          data: { status: "errored", completedAt: new Date(), resultMessage: "stale_attempt_reaped" },
        });
        await recordFunnelEvent(tx, eventContext, {
          eventName: "purchase_failed",
          planId: existing.planId,
          paymentAttemptId: existing.id,
          reason: "errored",
        });
      }

      const created = await tx.paymentAttempt.create({ data: { userId, planId: plan.id, idempotencyKey } });
      await recordFunnelEvent(tx, eventContext, {
        eventName: "purchase_attempted",
        planId: plan.id,
        paymentAttemptId: created.id,
      });
      return { attempt: created, created: true };
    });
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;

    // The conflict can come from either unique index — the losing insert
    // might collide on this exact idempotency key, or on the one-active-
    // attempt-per-user index because a differently-keyed request won the
    // race instead. Check the more specific match first.
    const byKey = idempotencyKey
      ? await prisma.paymentAttempt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } })
      : null;
    const existing =
      byKey ?? (await prisma.paymentAttempt.findFirst({ where: { userId, status: { in: ["initiated", "processing"] } } }));
    if (!existing) throw err;
    return { attempt: existing, created: false };
  }
}

// Runs one Purchase request through the full payment lifecycle (spec.md
// 11): joins the user's existing payment operation if one is already
// active (spec.md 13, stage 12), otherwise creates the payment_attempt
// (`initiated`), advances it to `processing`, calls the fake PSP, and —
// success only — creates the Purchase atomically with the attempt's
// `succeeded` transition (enforced at the DB level by the
// `purchases_require_succeeded_attempt` trigger). `purchase_attempted`/
// `purchase_succeeded`/`purchase_failed` are recorded at the point each
// corresponding state actually exists, never earlier.
export async function processPurchase(params: {
  session: Session;
  userId: string;
  plan: Plan;
  card: CardInput;
  pspOptions?: { timeoutDelayMs?: number };
  // Optional client-supplied correlation id for one logical purchase
  // action (stage 12) — see beginAttempt's doc comment. Omitting it still
  // gets the full per-user active-attempt guarantee, just not recognition
  // of a repeat request after the original has already gone terminal.
  idempotencyKey?: string;
}): Promise<PurchaseOutcome> {
  const { session, userId, plan, card, pspOptions, idempotencyKey } = params;
  const eventContext: FunnelEventContext = { sessionId: session.id, userId };

  const begun = await beginAttempt(eventContext, userId, plan, idempotencyKey);
  if (!begun.created) {
    return outcomeForExistingAttempt(begun.attempt);
  }
  const attempt = begun.attempt;

  // Tracks whether the attempt made it to `processing` before a failure —
  // the status-transition trigger only allows moving to a terminal state
  // from `processing`, so an error before that point must be left as-is
  // (spec.md 11: roll back to the last consistent state, never a forced
  // invalid transition).
  let reachedProcessing = false;

  try {
    await prisma.paymentAttempt.update({ where: { id: attempt.id }, data: { status: "processing" } });
    reachedProcessing = true;

    const result = await processFakePayment(
      { cardNumber: card.number, expiry: card.expiry, cvc: card.cvc },
      pspOptions,
    );

    if (result.outcome === "succeeded") {
      const { updatedAttempt, purchase } = await prisma.$transaction(async (tx) => {
        const updatedAttempt = await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "succeeded", maskedCardNumber: result.maskedCardNumber, completedAt: new Date() },
        });
        const purchase = await tx.purchase.create({
          data: {
            paymentAttemptId: attempt.id,
            userId,
            planId: plan.id,
            amount: plan.priceAmount,
            currency: plan.currency,
          },
        });
        await recordFunnelEvent(tx, eventContext, {
          eventName: "purchase_succeeded",
          planId: plan.id,
          paymentAttemptId: attempt.id,
          purchaseId: purchase.id,
          amount: plan.priceAmount,
        });
        return { updatedAttempt, purchase };
      });
      return { outcome: "succeeded", attempt: updatedAttempt, purchase };
    }

    const updatedAttempt = await prisma.$transaction(async (tx) => {
      const updated = await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: result.outcome,
          maskedCardNumber: result.maskedCardNumber,
          resultMessage: result.outcome === "declined" ? result.reason : null,
          completedAt: new Date(),
        },
      });
      await recordFunnelEvent(tx, eventContext, {
        eventName: "purchase_failed",
        planId: plan.id,
        paymentAttemptId: attempt.id,
        reason: result.outcome,
      });
      return updated;
    });

    return result.outcome === "declined"
      ? { outcome: "declined", attempt: updatedAttempt, reason: result.reason }
      : { outcome: "timed_out", attempt: updatedAttempt };
  } catch (err) {
    if (!reachedProcessing) throw err;

    try {
      await prisma.$transaction(async (tx) => {
        await tx.paymentAttempt.update({
          where: { id: attempt.id },
          data: { status: "errored", completedAt: new Date() },
        });
        await recordFunnelEvent(tx, eventContext, {
          eventName: "purchase_failed",
          planId: plan.id,
          paymentAttemptId: attempt.id,
          reason: "errored",
        });
      });
    } catch {
      // Best effort: if even the errored-transition fails, surface the
      // original error to the caller rather than a second, less useful one.
    }
    return { outcome: "errored", attempt };
  }
}
