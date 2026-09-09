import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { attributionOverrideFromBody } from "@/lib/attribution";
import { setVisitorCookie } from "@/lib/cookies";
import { prisma } from "@/lib/db";
import { recordFunnelEvent, type Screen } from "@/lib/analytics";
import { getSucceededPurchase } from "@/lib/install";

const VALID_SCREENS: readonly Screen[] = ["start", "quiz", "email", "paywall", "payment", "install"];

// Records a `screen_view` event (spec.md 10) for the funnel screen currently
// shown to the user. Self-sufficient like /api/identify: resolves (creating
// if necessary) the visitor/session itself rather than assuming a prior
// /api/session call, so a screen reached directly (e.g. a deep link) still
// establishes identity correctly — including attribution, via the same
// `{ landingUrl, referrer }` override /api/session accepts.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "invalid JSON body" }, { status: 400 });
  }

  const screen = typeof body === "object" && body !== null ? (body as Record<string, unknown>).screen : undefined;
  const step = typeof body === "object" && body !== null ? (body as Record<string, unknown>).step : undefined;

  if (typeof screen !== "string" || !VALID_SCREENS.includes(screen as Screen)) {
    return NextResponse.json({ status: "error", message: "invalid screen" }, { status: 400 });
  }
  if (screen === "quiz" && typeof step !== "string") {
    return NextResponse.json({ status: "error", message: "step is required for screen=quiz" }, { status: 400 });
  }

  const attributionOverride = attributionOverrideFromBody(body, request.headers.get("user-agent"));
  const { visitor, session } = await resolveVisitorSession(request, attributionOverride);

  const eventContext = { sessionId: session.id, userId: visitor.userId };

  await recordFunnelEvent(
    prisma,
    eventContext,
    screen === "quiz"
      ? { eventName: "screen_view", screen: "quiz", step: step as string }
      : { eventName: "screen_view", screen: screen as Exclude<Screen, "quiz"> },
  );

  // install_viewed (spec.md 10) carries a purchase_id, which — like every
  // other identifier here — is never taken from the client: it's looked up
  // fresh from this visitor's own linked user, and simply skipped if none
  // exists (e.g. this same generic endpoint reached directly without ever
  // having passed the Install page's own server-side guard).
  if (screen === "install" && visitor.userId) {
    const purchase = await getSucceededPurchase(visitor.userId);
    if (purchase) {
      await recordFunnelEvent(prisma, eventContext, { eventName: "install_viewed", purchaseId: purchase.id });
    }
  }

  const response = NextResponse.json({ status: "ok" });
  setVisitorCookie(response, request, visitor.id);
  return response;
}
