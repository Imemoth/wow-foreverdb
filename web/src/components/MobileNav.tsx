"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SUPPORT_URL } from "@/lib/support-link";

/**
 * Mobile hamburger disclosure. ADR-015: like SiteHeader.tsx, this file must never import
 * account modules or inspect session/feature-flag state. No Account entry here, matching the
 * desktop header: for the current public-beta scope (Account Auth disabled) a global,
 * state-agnostic /account link is misleading, and this file cannot safely make it conditional
 * without crossing the boundary - the real /account app and its own nav are unaffected.
 */
const MENU_LINKS = [
  { href: "/database", label: "Database" },
  { href: "/zones", label: "Zones" },
  { href: "/guides", label: "Guides" },
  { href: "/news", label: "News" },
  { href: "/blog", label: "Blog" },
  { href: "/download", label: "Download" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);
  // The header's actual bottom edge, not a guessed constant: it also sits below the optional
  // DatasetBanner (synthetic-data notice), whose height varies, so a fixed Tailwind offset would
  // either overlap the header or leave a gap depending on whether that banner is showing.
  const [panelTop, setPanelTop] = useState(0);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const measure = () => {
      const header = toggleRef.current?.closest("header");
      if (header) setPanelTop(header.getBoundingClientRect().bottom);
    };
    measure();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || toggleRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", measure);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 w-11 items-center justify-center rounded-md text-parchment hover:bg-ink-800 hover:text-violet-300"
      >
        {open ? (
          <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        )}
      </button>

      {open &&
        createPortal(
          <>
            {/*
              Portalled to document.body rather than rendered in place: the header carries a
              backdrop-filter (its translucent blur), and per spec that gives it a containing
              block for fixed-position descendants - any "fixed" element left nested inside it
              would be sized/positioned off the HEADER's own small box, not the viewport, and
              would paint inside the header's own stacking context, i.e. behind <main> in DOM
              order. A body-level portal keeps this a normal top-level fixed overlay.
            */}
            <div className="fixed inset-x-0 bottom-0 z-40 bg-ink-950/70" style={{ top: panelTop }} aria-hidden="true" />
            <div
              id={panelId}
              ref={panelRef}
              className="fixed inset-x-0 z-50 overflow-y-auto border-b border-ink-700 bg-ink-900 shadow-2xl shadow-black/60"
              style={{ top: panelTop, maxHeight: `calc(100vh - ${panelTop}px)` }}
            >
              <nav aria-label="Primary" className="p-2">
                <ul className="flex flex-col gap-1 text-base">
                  {MENU_LINKS.map((n) => (
                    <li key={n.href}>
                      <Link
                        href={n.href}
                        onClick={() => setOpen(false)}
                        className="flex min-h-11 items-center rounded-md px-3 py-2.5 text-parchment no-underline hover:bg-ink-800 hover:text-violet-300"
                      >
                        {n.label}
                      </Link>
                    </li>
                  ))}
                  <li className="mt-1 border-t border-ink-700/80 pt-1">
                    {/* Last item, visually secondary: a plain external link, not another nav
                        destination. See SiteHeader.tsx's desktop placement for the same link. */}
                    <a
                      href={SUPPORT_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setOpen(false)}
                      className="flex min-h-11 items-center rounded-md border border-gold-500/30 bg-ink-950/60 px-3 py-2.5 text-sm font-medium text-mist no-underline hover:border-gold-500/60 hover:text-violet-300"
                    >
                      ☕ Support AzerDex
                    </a>
                  </li>
                </ul>
              </nav>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
