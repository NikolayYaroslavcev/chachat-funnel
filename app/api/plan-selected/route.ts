import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { recordPlanSelection, InvalidPlanError } from "@/lib/paywall";
import { setVisitorCookie } from "@/lib/cookies";

// Records plan_selected (spec.md 4.4, 10) when a user picks a plan on the
// Paywall. Requires an identified visitor server-side — spec.md 4 requires
// the server, not client navigation, to enforce Paywall's precondition, so
// this endpoint checks it itself rather than trusting the calling page.
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
