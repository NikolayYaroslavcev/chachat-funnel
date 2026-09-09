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

function attributionFromLandingUrl(
  landingUrl: string,
  referrer: string | null,
  userAgent: string | null,
): Attribution {
  let params = new URLSearchParams();
  try {
    params = new URL(landingUrl).searchParams;
  } catch {
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

export function attributionOverrideFromBody(body: unknown, userAgent: string | null): Attribution | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.landingUrl !== "string" || record.landingUrl.length === 0) return undefined;
  const referrer = typeof record.referrer === "string" ? record.referrer : null;
  return attributionFromLandingUrl(record.landingUrl, referrer, userAgent);
}
