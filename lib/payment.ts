import { Prisma, type PaymentAttempt, type Plan, type Purchase, type Session } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordFunnelEvent, type FunnelEventContext } from "@/lib/analytics";
import { processFakePayment } from "@/lib/fake-psp";

export type CardInput = { number: string; expiry: string; cvc: string };

export type PurchaseOutcome =
  | { outcome: "succeeded"; attempt: PaymentAttempt; purchase: Purchase }
  | { outcome: "declined"; attempt: PaymentAttempt; reason: "card_declined" | "unsupported_test_card" }
  | { outcome: "timed_out"; attempt: PaymentAttempt }
  | { outcome: "errored"; attempt: PaymentAttempt | null }
  | { outcome: "duplicate"; attempt: PaymentAttempt };

const STALE_ACTIVE_ATTEMPT_MS = 60_000;

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

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

    const byKey = idempotencyKey
      ? await prisma.paymentAttempt.findUnique({ where: { userId_idempotencyKey: { userId, idempotencyKey } } })
      : null;
    const existing =
      byKey ?? (await prisma.paymentAttempt.findFirst({ where: { userId, status: { in: ["initiated", "processing"] } } }));
    if (!existing) throw err;
    return { attempt: existing, created: false };
  }
}

export async function processPurchase(params: {
  session: Session;
  userId: string;
  plan: Plan;
  card: CardInput;
  pspOptions?: { timeoutDelayMs?: number };
  idempotencyKey?: string;
}): Promise<PurchaseOutcome> {
  const { session, userId, plan, card, pspOptions, idempotencyKey } = params;
  const eventContext: FunnelEventContext = { sessionId: session.id, userId };

  const begun = await beginAttempt(eventContext, userId, plan, idempotencyKey);
  if (!begun.created) {
    return outcomeForExistingAttempt(begun.attempt);
  }
  const attempt = begun.attempt;

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
    }
    return { outcome: "errored", attempt };
  }
}
