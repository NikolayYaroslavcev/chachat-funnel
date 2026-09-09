import type { NextRequest, NextResponse } from "next/server";

export const VISITOR_COOKIE_NAME = "cc_vid";

const VISITOR_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) return forwardedProto === "https";
  return request.nextUrl.protocol === "https:";
}

export function setVisitorCookie(response: NextResponse, request: NextRequest, visitorId: string): void {
  response.cookies.set(VISITOR_COOKIE_NAME, visitorId, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
  });
}
