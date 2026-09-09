"use client";

import { useEffect, useRef } from "react";

type Props = { screen: "start" | "quiz" | "email" | "paywall" | "install"; step?: string };

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
