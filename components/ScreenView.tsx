"use client";

import { useEffect, useRef } from "react";

type Props = { screen: "start" | "quiz" | "email" | "paywall" | "install"; step?: string };

// Records a screen_view (spec.md 10) once per real mount. Render with a
// `key` tied to the screen identity (e.g. the quiz step) at the call site so
// navigating between steps — each its own route — remounts this and fires a
// fresh event, rather than relying on prop-change detection.
export function ScreenView({ screen, step }: Props) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    fetch("/api/screen-view", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        screen,
        step,
        landingUrl: window.location.href,
        referrer: document.referrer || null,
      }),
      keepalive: true,
    }).catch(() => {});
  }, [screen, step]);

  return null;
}
