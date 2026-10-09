"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string };
  }
}

/** Loads Cloudflare Turnstile and exchanges its token for a server-verified pass. */
export function TurnstileWidget({ siteKey }: { siteKey: string }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"idle" | "ok" | "error">("idle");

  useEffect(() => {
    const render = () => {
      if (!box.current || !window.turnstile) return;
      window.turnstile.render(box.current, {
        sitekey: siteKey,
        callback: async (token: string) => {
          const r = await fetch("/api/v1/challenge", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }),
          }).catch(() => null);
          setState(r?.ok ? "ok" : "error");
        },
      });
    };
    if (window.turnstile) return render();
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.onload = render;
    document.head.appendChild(s);
  }, [siteKey]);

  return (
    <div className="space-y-3">
      <div ref={box} />
      <p role="status" className="text-sm text-mist">
        {state === "ok" && "Thanks — you can continue browsing."}
        {state === "error" && "Verification failed. Please try again."}
      </p>
    </div>
  );
}
