import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { recordPlanSelection, InvalidPlanError } from "@/lib/paywall";
import { setVisitorCookie } from "@/lib/cookies";

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

  const { visitor, session } = await resolveVisitorSession(request);

  if (!visitor.userId) {
    const response = NextResponse.json({ status: "error", message: "identification required" }, { status: 403 });
    setVisitorCookie(response, request, visitor.id);
    return response;
  }

  try {
    const plan = await recordPlanSelection(session, visitor, planId);
    const response = NextResponse.json({ status: "ok", planId: plan.id });
    setVisitorCookie(response, request, visitor.id);
    return response;
  } catch (err) {
    if (err instanceof InvalidPlanError) {
      const response = NextResponse.json({ status: "error", message: "invalid plan" }, { status: 400 });
      setVisitorCookie(response, request, visitor.id);
      return response;
    }
    throw err;
  }
}
