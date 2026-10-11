"use client";

import { useEffect, useRef } from "react";

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
}
const api = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile;

/**
 * Cloudflare Turnstile for the sign-up, resend and recovery forms. The token is single-use, so the widget is reset
 * whenever `resetSignal` changes (after every submit attempt). Verification happens SERVER-side; this only collects the token.
 * (Bot protection for the website's own routes: it does not protect Supabase Auth itself.)
 */
export function AccountTurnstile({ siteKey, onToken, resetSignal }: { siteKey: string; onToken: (t: string | null) => void; resetSignal: number }) {
  const box = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);

  useEffect(() => {
    const render = () => {
      const t = api();
      if (!box.current || !t || widget.current !== null) return;
      widget.current = t.render(box.current, {
        sitekey: siteKey,
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };
    if (api()) return render();
    const existing = document.querySelector<HTMLScriptElement>("script[data-fdb-turnstile]");
    if (existing) {
      existing.addEventListener("load", render);
      return () => existing.removeEventListener("load", render);
    }
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    s.dataset.fdbTurnstile = "1";
    s.onload = render;
    document.head.appendChild(s);
  }, [siteKey, onToken]);

  useEffect(() => {
    if (resetSignal > 0 && widget.current !== null) {
      onToken(null);
      api()?.reset(widget.current);
    }
  }, [resetSignal, onToken]);

  return <div ref={box} aria-label="Human verification" />;
}
