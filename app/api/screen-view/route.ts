import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { attributionOverrideFromBody } from "@/lib/attribution";
import { setVisitorCookie } from "@/lib/cookies";
import { prisma } from "@/lib/db";
import { recordFunnelEvent, type Screen } from "@/lib/analytics";
import { getSucceededPurchase } from "@/lib/install";

const VALID_SCREENS: readonly Screen[] = ["start", "quiz", "email", "paywall", "payment", "install"];

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
