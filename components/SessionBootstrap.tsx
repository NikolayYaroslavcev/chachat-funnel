"use client";

import { useEffect, useRef } from "react";

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
    });
  }, []);

  return null;
}
