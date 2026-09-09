import type { NextRequest, NextResponse } from "next/server";

// The visitor row's id doubles as the client-facing token (see the comment
// on the Visitor model in prisma/schema.prisma) — no separate opaque token
// column, so the cookie just carries the cuid directly.
export const VISITOR_COOKIE_NAME = "cc_vid";

// 400 days is the practical ceiling browsers honor for Set-Cookie Max-Age.
// Visitor identity is meant to persist indefinitely across sessions
// (spec.md 5), so this is simply "as long as the browser allows" — the
// exact lifetime is an implementation detail left open by spec.md 20.
const VISITOR_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

// `NODE_ENV === "production"` is the wrong signal for the Secure attribute:
// `next start` sets it to "production" regardless of whether the actual
// deployment terminates TLS (this repo's docker-compose stack exposes plain
// HTTP on purpose). A Secure cookie set over plain HTTP is accepted by the
// browser but then never sent back on subsequent plain-HTTP requests,
// silently breaking the whole persistence mechanism. Key off the request's
// actual protocol instead.
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
