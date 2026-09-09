import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { setVisitorCookie } from "@/lib/cookies";
import { prisma } from "@/lib/db";
import { processPurchase, type CardInput, type PurchaseOutcome } from "@/lib/payment";

function extractCard(body: unknown): CardInput | null {
  if (typeof body !== "object" || body === null || !("card" in body)) return null;
  const card = (body as { card: unknown }).card;
  if (typeof card !== "object" || card === null) return null;
  const { number, expiry, cvc } = card as Record<string, unknown>;
  if (typeof number !== "string" || typeof expiry !== "string" || typeof cvc !== "string") return null;
  return { number, expiry, cvc };
}

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
