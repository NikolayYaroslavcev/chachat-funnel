import { Prisma, type FunnelEvent, type FunnelEventName, type PrismaClient } from "@prisma/client";

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export type Screen = "start" | "quiz" | "email" | "paywall" | "payment" | "install";

type ScreenViewInput =
  | { eventName: "screen_view"; screen: "quiz"; step: string }
  | { eventName: "screen_view"; screen: Exclude<Screen, "quiz"> };

export type FunnelEventInput =
  | ScreenViewInput
  | { eventName: "quiz_answer_submitted"; questionKey: string; answerValue: string }
  | { eventName: "quiz_completed" }
  | { eventName: "email_submitted"; isNewUser: boolean; isExistingUser: boolean }
  | { eventName: "plan_selected"; planId: string }
  | {
      eventName: "purchase_attempted";
      planId: string;
      paymentAttemptId: string;
      isDuplicate?: boolean;
    }
  | {
      eventName: "purchase_succeeded";
      planId: string;
      paymentAttemptId: string;
      purchaseId: string;
      amount: Prisma.Decimal | number | string;
    }
  | {
      eventName: "purchase_failed";
      planId: string;
      paymentAttemptId: string;
      reason: "declined" | "timed_out" | "errored";
    }
  | { eventName: "install_viewed"; purchaseId: string };

export type FunnelEventContext = {
  sessionId: string;
  userId?: string | null;
};

type EventRow = {
  eventName: FunnelEventName;
  properties: Prisma.InputJsonValue | undefined;
  planId: string | null;
  paymentAttemptId: string | null;
  purchaseId: string | null;
};

function toEventRow(input: FunnelEventInput): EventRow {
  switch (input.eventName) {
    case "screen_view":
      return {
        eventName: "screen_view",
        properties:
          input.screen === "quiz" ? { screen: input.screen, step: input.step } : { screen: input.screen },
        planId: null,
        paymentAttemptId: null,
        purchaseId: null,
      };
    case "quiz_answer_submitted":
      return {
        eventName: "quiz_answer_submitted",
        properties: { question_key: input.questionKey, answer_value: input.answerValue },
        planId: null,
        paymentAttemptId: null,
        purchaseId: null,
      };
    case "quiz_completed":
      return {
        eventName: "quiz_completed",
        properties: undefined,
        planId: null,
        paymentAttemptId: null,
        purchaseId: null,
      };
    case "email_submitted":
      return {
        eventName: "email_submitted",
        properties: { is_new_user: input.isNewUser, is_existing_user: input.isExistingUser },
        planId: null,
        paymentAttemptId: null,
        purchaseId: null,
      };
    case "plan_selected":
      return {
        eventName: "plan_selected",
        properties: { plan_id: input.planId },
        planId: input.planId,
        paymentAttemptId: null,
        purchaseId: null,
      };
    case "purchase_attempted":
      return {
        eventName: "purchase_attempted",
        properties: {
          payment_attempt_id: input.paymentAttemptId,
          plan_id: input.planId,
          ...(input.isDuplicate !== undefined ? { is_duplicate: input.isDuplicate } : {}),
        },
        planId: input.planId,
        paymentAttemptId: input.paymentAttemptId,
        purchaseId: null,
      };
    case "purchase_succeeded":
      return {
        eventName: "purchase_succeeded",
        properties: {
          payment_attempt_id: input.paymentAttemptId,
          purchase_id: input.purchaseId,
          plan_id: input.planId,
          amount: input.amount.toString(),
        },
        planId: input.planId,
        paymentAttemptId: input.paymentAttemptId,
        purchaseId: input.purchaseId,
      };
    case "purchase_failed":
      return {
        eventName: "purchase_failed",
        properties: {
          payment_attempt_id: input.paymentAttemptId,
          plan_id: input.planId,
          reason: input.reason,
        },
        planId: input.planId,
        paymentAttemptId: input.paymentAttemptId,
        purchaseId: null,
      };
    case "install_viewed":
      return {
        eventName: "install_viewed",
        properties: { purchase_id: input.purchaseId },
        planId: null,
        paymentAttemptId: null,
        purchaseId: input.purchaseId,
      };
  }
}

export async function recordFunnelEvent(
  client: PrismaClientOrTx,
  context: FunnelEventContext,
  input: FunnelEventInput,
): Promise<FunnelEvent> {
  const row = toEventRow(input);
  return client.funnelEvent.create({
    data: {
      sessionId: context.sessionId,
      userId: context.userId ?? null,
      eventName: row.eventName,
      properties: row.properties,
      planId: row.planId,
      paymentAttemptId: row.paymentAttemptId,
      purchaseId: row.purchaseId,
    },
  });
}
