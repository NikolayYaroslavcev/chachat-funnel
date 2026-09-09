import { Prisma, type FunnelEvent, type FunnelEventName, type PrismaClient } from "@prisma/client";

// Reusable funnel-event recording mechanism (spec.md 10). Every later funnel
// stage (Quiz, Email, Paywall, Payment, Install) should call
// `recordFunnelEvent` instead of writing to `funnel_events` directly, so the
// event shape (property keys, required relations) stays centralized in one
// place instead of drifting per call site.
//
// Deliberately a single function over a discriminated union, not one
// function per event: the union is what makes an event's required
// properties/relations a compile-time error to omit, without inventing a
// second analytics model alongside `FunnelEvent`.

// Accepts either the shared client or an open transaction, so a caller that
// needs the event committed atomically with a business-logic change (e.g.
// `email_submitted` alongside the visitor->user link, or the future
// `purchase_succeeded` alongside purchase creation) can pass its `tx` and
// get one atomic write; a caller with no surrounding transaction just passes
// `prisma`.
type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient;

export type Screen = "start" | "quiz" | "email" | "paywall" | "payment" | "install";

type ScreenViewInput =
  // `step` is required for quiz (spec.md 10: "step (для quiz)") and absent
  // otherwise, encoded as a nested union so omitting it for `screen: "quiz"`
  // is a compile error rather than a silently-missing property.
  | { eventName: "screen_view"; screen: "quiz"; step: string }
  | { eventName: "screen_view"; screen: Exclude<Screen, "quiz"> };

// One variant per `FunnelEventName` (spec.md 10's event table). Each variant
// carries exactly the properties/relations that event requires — the union
// is what the compiler holds later callers to.
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
      // Optional, non-normative per spec.md 10's note on purchase_attempted:
      // a duplicate click that didn't create a new payment_attempt may
      // still be logged for debugging with `is_duplicate: true`, without
      // that being required or affecting funnel-conversion counts.
      isDuplicate?: boolean;
    }
  | {
      eventName: "purchase_succeeded";
      planId: string;
      paymentAttemptId: string;
      purchaseId: string;
      // Accepted as Decimal | number | string and always persisted as a
      // string (see toEventRow) so the JSON property preserves exact
      // currency precision instead of round-tripping through a JS float.
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
  // Point-in-time identity snapshot, per the `userId` comment on the
  // `FunnelEvent` model: null for a pre-identification event, and never
  // rewritten retroactively once identification happens later.
  userId?: string | null;
};

type EventRow = {
  eventName: FunnelEventName;
  properties: Prisma.InputJsonValue | undefined;
  planId: string | null;
  paymentAttemptId: string | null;
  purchaseId: string | null;
};

// Translates a typed `FunnelEventInput` into the row shape `funnel_events`
// actually stores: a JSON `properties` blob with the exact snake_case keys
// spec.md 10's table names (so the persisted shape matches the spec
// verbatim, not a TS-camelCase reinterpretation of it), plus the relation
// columns (`plan_id`/`payment_attempt_id`/`purchase_id`) the same values
// also populate, so downstream SQL can join on the columns without parsing
// JSON.
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

// Records one funnel event (spec.md 10). No deduplication happens here on
// purpose: `funnel_events` is an append-only log (enforced at the DB level
// by a trigger — see schema.prisma), and whether a given call represents a
// repeatable action (e.g. `screen_view`, `email_submitted` — fires every
// time the action genuinely happens) or a one-time business transition
// (e.g. `purchase_succeeded`, which can only happen once per attempt by
// construction — see the `purchases_require_succeeded_attempt` trigger) is a
// business-logic decision belonging to the calling stage, not to this
// mechanism. For `purchase_attempted` specifically, spec.md 10 says a
// retried click that a later payment stage recognizes as a duplicate of an
// already-active attempt should not call this with a new `paymentAttemptId`
// at all — that recognition happens in the payment stage, not here.
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
