import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { setVisitorCookie } from "@/lib/cookies";
import { prisma } from "@/lib/db";
import { processPurchase, type CardInput, type PurchaseOutcome } from "@/lib/payment";

// The Paywall's Purchase action (spec.md 4.4-4.5, 11): validates
// identification and the selected plan, then runs the request through the
// full payment lifecycle in lib/payment.ts. The amount charged always comes
// from the plan row looked up here, never from anything the client sends
// (spec.md: "server must not trust client-provided plan price/amount").
//
// Card fields are read only to hand them to the fake PSP for this one
// request — never persisted or logged (see lib/payment.ts and lib/fake-psp.ts).
function extractCard(body: unknown): CardInput | null {
  if (typeof body !== "object" || body === null || !("card" in body)) return null;
  const card = (body as { card: unknown }).card;
  if (typeof card !== "object" || card === null) return null;
  const { number, expiry, cvc } = card as Record<string, unknown>;
  if (typeof number !== "string" || typeof expiry !== "string" || typeof cvc !== "string") return null;
  return { number, expiry, cvc };
}

// Optional (stage 12, spec.md 13): a client-supplied correlation id for one
// logical purchase action, forwarded as-is to processPurchase. Absent or
// wrong-typed just means this request doesn't opt into idempotent-replay
// recognition — the active-attempt guarantee still applies regardless.
function extractIdempotencyKey(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("idempotencyKey" in body)) return undefined;
  const key = (body as { idempotencyKey: unknown }).idempotencyKey;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function toStatusCode(result: PurchaseOutcome): number {
  switch (result.outcome) {
    case "succeeded":
    case "declined":
    case "timed_out":
      return 200;
    case "duplicate":
      return 409;
    case "errored":
      return 500;
  }
}

function toBody(result: PurchaseOutcome) {
  switch (result.outcome) {
    case "succeeded":
      return {
        status: "succeeded",
        purchase: {
          id: result.purchase.id,
          planId: result.purchase.planId,
          amount: result.purchase.amount.toString(),
          currency: result.purchase.currency,
        },
      };
    case "declined":
      return { status: "declined", reason: result.reason, paymentAttemptId: result.attempt.id };
    case "timed_out":
      return { status: "timed_out", paymentAttemptId: result.attempt.id };
    case "duplicate":
      // A payment operation for this user was already in flight when this
      // request arrived (double-click, second tab, retry/refresh — spec.md
      // 13); this request joined it rather than starting a second one.
      // `attemptStatus` reflects that existing operation's current status,
      // not this request's own outcome.
      return {
        status: "duplicate",
        message: "A payment is already in progress for this account.",
        paymentAttemptId: result.attempt.id,
        attemptStatus: result.attempt.status,
      };
    case "errored":
      return { status: "errored", message: "Something went wrong processing your payment." };
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "invalid JSON body" }, { status: 400 });
  }

  const planId =
    typeof body === "object" && body !== null && "planId" in body ? (body as { planId: unknown }).planId : undefined;

  if (typeof planId !== "string") {
    return NextResponse.json({ status: "error", message: "planId is required" }, { status: 400 });
  }

  const card = extractCard(body);
  if (!card) {
    return NextResponse.json({ status: "error", message: "card is required" }, { status: 400 });
  }

  const idempotencyKey = extractIdempotencyKey(body);

  const { visitor, session } = await resolveVisitorSession(request);

  if (!visitor.userId) {
    const response = NextResponse.json({ status: "error", message: "identification required" }, { status: 403 });
    setVisitorCookie(response, request, visitor.id);
    return response;
  }

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) {
    const response = NextResponse.json({ status: "error", message: "invalid plan" }, { status: 400 });
    setVisitorCookie(response, request, visitor.id);
    return response;
  }

  let result: PurchaseOutcome;
  try {
    result = await processPurchase({ session, userId: visitor.userId, plan, card, idempotencyKey });
  } catch {
    const response = NextResponse.json(
      { status: "error", message: "payment processing failed" },
      { status: 500 },
    );
    setVisitorCookie(response, request, visitor.id);
    return response;
  }

  const response = NextResponse.json(toBody(result), { status: toStatusCode(result) });
  setVisitorCookie(response, request, visitor.id);
  return response;
}
