import { NextResponse, type NextRequest } from "next/server";
import { resolveVisitorSession } from "@/lib/visitor-session";
import { attributionOverrideFromBody } from "@/lib/attribution";
import { setVisitorCookie } from "@/lib/cookies";

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
