import type { NextRequest } from "next/server";

export type Attribution = {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrer: string | null;
  landingUrl: string;
  userAgent: string | null;
};

// Attribution is captured once, from the request that creates a session
// (spec.md 8): its own query string (UTM params), its Referer header, and
// its full URL. Which request that ends up being (a page load intercepted
// by middleware, vs. a client-initiated bootstrap call forwarding the
// current query string) is exactly the "API route organization" detail
// spec.md 20 leaves open — this just reads whatever request it's given.
export function extractAttribution(request: NextRequest): Attribution {
  const params = request.nextUrl.searchParams;
  return {
    utmSource: params.get("utm_source"),
    utmMedium: params.get("utm_medium"),
    utmCampaign: params.get("utm_campaign"),
    utmTerm: params.get("utm_term"),
    utmContent: params.get("utm_content"),
    referrer: request.headers.get("referer"),
    landingUrl: request.nextUrl.toString(),
    userAgent: request.headers.get("user-agent"),
  };
}

// Session-establishing calls (POST /api/session, POST /api/screen-view) are
// same-origin fetches issued by client JS *after* the real landing
// navigation already happened — their own `request.nextUrl`/`Referer` would
// just describe the API route itself (e.g. "/api/session"), not the page the
// visitor actually landed on. To avoid silently overwriting real attribution
// with that internal request's own URL, callers instead forward the values
// the browser captured at the real landing navigation (`window.location.href`,
// `document.referrer`), and this builds an Attribution from those instead of
// from the wrapping request.
function attributionFromLandingUrl(
  landingUrl: string,
  referrer: string | null,
  userAgent: string | null,
): Attribution {
  let params = new URLSearchParams();
  try {
    params = new URL(landingUrl).searchParams;
  } catch {
    // Malformed/relative landingUrl from a misbehaving client: fall back to
    // no UTM params rather than rejecting the whole request over it.
  }
  return {
    utmSource: params.get("utm_source"),
    utmMedium: params.get("utm_medium"),
    utmCampaign: params.get("utm_campaign"),
    utmTerm: params.get("utm_term"),
    utmContent: params.get("utm_content"),
    referrer: referrer || null,
    landingUrl,
    userAgent,
  };
}

// Shared parsing for the `{ landingUrl, referrer }` shape both /api/session
// and /api/screen-view accept in their JSON body (see attributionFromLandingUrl).
// Returns undefined when the body carries no usable landingUrl, so the
// caller falls back to request-derived attribution.
export function attributionOverrideFromBody(body: unknown, userAgent: string | null): Attribution | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.landingUrl !== "string" || record.landingUrl.length === 0) return undefined;
  const referrer = typeof record.referrer === "string" ? record.referrer : null;
  return attributionFromLandingUrl(record.landingUrl, referrer, userAgent);
}
