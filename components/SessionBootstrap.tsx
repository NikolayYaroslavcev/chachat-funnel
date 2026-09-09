"use client";

import { useEffect, useRef } from "react";

// Establishes the anonymous visitor/session at funnel entry (spec.md 4.1),
// mounted once on the Start screen. Forwards the browser's own record of the
// real landing navigation (window.location.href, document.referrer) instead
// of letting the server derive attribution from this same-origin fetch's own
// URL/Referer header, which would just describe "/api/session" — see
// lib/attribution.ts.
export function SessionBootstrap() {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        landingUrl: window.location.href,
        referrer: document.referrer || null,
      }),
      keepalive: true,
    }).catch(() => {
      // Best-effort: a failed bootstrap call doesn't block rendering. The
      // next self-sufficient call (screen-view, quiz answer) will retry
      // establishing the visitor/session anyway.
    });
  }, []);

  return null;
}
