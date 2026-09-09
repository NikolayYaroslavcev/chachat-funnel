import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { attributionOverrideFromBody } from "@/lib/attribution";
import { setVisitorCookie } from "@/lib/cookies";

// Establishes or continues the current visit: creates an anonymous visitor
// + session if needed, or reuses/bumps the current one (spec.md 4.1, 7).
// Called at funnel entry (the Start screen).
//
// Optional JSON body `{ landingUrl, referrer }`: this endpoint is hit by a
// same-origin client fetch *after* the real landing navigation, so its own
// request URL/Referer header describe "/api/session", not the page the
// visitor actually landed on. The Start screen forwards what the browser
// captured at that real navigation (window.location.href, document.referrer)
// here instead, so first-touch attribution reflects the real landing
// request rather than this internal call.
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }

  const attributionOverride = attributionOverrideFromBody(body, request.headers.get("user-agent"));
  const { visitor, isNewVisitor, isNewSession } = await resolveVisitorSession(request, attributionOverride);

  const response = NextResponse.json({ status: "ok", isNewVisitor, isNewSession });
  setVisitorCookie(response, request, visitor.id);
  return response;
}
