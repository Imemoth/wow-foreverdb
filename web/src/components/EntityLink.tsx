"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * Database link with an accessible hover/focus tooltip. Tooltip data comes from
 * the cacheable, rate-limited /api/v1/tooltip endpoint and is rendered as text
 * only (React-escaped). Escape closes it; it never traps focus.
 */

type Tip = { title: string; subtitle: string; lines: string[] };
const cache = new Map<string, Promise<Tip | null>>();

function load(url: string): Promise<Tip | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url, { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<Tip>) : null))
      .catch(() => null);
    cache.set(url, p);
  }
  return p;
}

export function EntityLink({
  href, tooltip, children, className,
}: { href: string; tooltip?: string; children: React.ReactNode; className?: string }) {
  const id = useId();
  const [tip, setTip] = useState<Tip | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const anchor = useRef<HTMLSpanElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (!tooltip) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const t = await load(tooltip);
      const r = anchor.current?.getBoundingClientRect();
      if (t && r) {
        // Fixed positioning escapes scrollable table containers; clamp to viewport.
        const width = 288;
        setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 6 });
        setTip(t);
        setOpen(true);
      }
    }, 220);
  }, [tooltip]);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <span ref={anchor} className="inline-block" onMouseEnter={show} onMouseLeave={hide}>
      <Link href={href} className={className ?? "font-medium"} onFocus={show} onBlur={hide}
        aria-describedby={open && tip ? id : undefined}>
        {children}
      </Link>
      {open && tip && (
        <span role="tooltip" id={id} style={{ left: pos.left, top: pos.top }}
          className="pointer-events-none fixed z-50 block w-72 rounded-lg border border-gold-500/50 bg-ink-900/95 p-3 text-left text-xs shadow-2xl shadow-black/60">
          <span className="block font-semibold text-gold-300">{tip.title}</span>
          <span className="block text-mist">{tip.subtitle}</span>
          {tip.lines.map((l, i) => (
            <span key={i} className="mt-1 block text-parchment">{l}</span>
          ))}
        </span>
      )}
    </span>
  );
}
