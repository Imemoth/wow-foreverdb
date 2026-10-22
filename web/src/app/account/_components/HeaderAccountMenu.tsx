"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { getJson } from "@/lib/account/client";
import { LogoutButton } from "./LogoutButton";

type Status = "unknown" | "guest" | "authed";

const GUEST_HREF = "/account/register";

const LINKS = [
  { href: "/account", label: "My account" },
  { href: "/account/link", label: "Link an installation" },
  { href: "/account/installations", label: "My installations" },
  { href: "/account/devices", label: "Devices" },
  { href: "/account/guildbook", label: "Guildbook" },
];

/**
 * Signed-in state for the header. The session cookie is HttpOnly and Path=/account, so the page cannot read it and
 * public pages never receive it; /account/api/me (same-origin, no token in JavaScript) is the only signal. Until it
 * answers (and whenever it fails) the entry is the guest link, which is always safe: a signed-in visitor who follows
 * it is redirected to /account by the register page, never shown the registration form.
 */
function useAccountStatus(): Status {
  const [status, setStatus] = useState<Status>("unknown");
  useEffect(() => {
    const ctl = new AbortController();
    getJson("/account/api/me", ctl.signal).then((r) => {
      if (ctl.signal.aborted) return;
      if (r.status === 401) setStatus("guest");
      else if (r.status === 200) setStatus(r.data.ok === true ? "authed" : "guest");
      // 0 / 404 / 503 / 5xx: keep the guest link, ask again on the next page load
    });
    return () => ctl.abort();
  }, []);
  return status;
}

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
    </svg>
  );
}

const TRIGGER =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-gold-500/50 bg-ink-950/60 px-2.5 py-1.5 text-sm font-medium text-parchment no-underline transition hover:border-gold-400 hover:text-violet-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400";

export function HeaderAccountMenu({ variant }: { variant: "desktop" | "mobile" }) {
  const status = useAccountStatus();
  return variant === "mobile" ? <MobileEntry status={status} /> : <DesktopEntry status={status} />;
}

function MobileEntry({ status }: { status: Status }) {
  if (status !== "authed") {
    return (
      <div className="mt-1 border-t border-ink-700/80 pt-1">
        <Link href={GUEST_HREF} className="flex min-h-11 items-center gap-2 rounded-md px-3 py-2.5 text-parchment no-underline hover:bg-ink-800 hover:text-violet-300" data-account-entry="guest">
          <PersonIcon /> Account
        </Link>
      </div>
    );
  }
  return (
    <div data-account-entry="authed" role="group" aria-label="Account" className="mt-1 border-t border-ink-700/80 pt-1">
      <ul className="flex flex-col gap-1">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex min-h-11 items-center rounded-md px-3 py-2.5 text-parchment no-underline hover:bg-ink-800 hover:text-violet-300">
              {l.label}
            </Link>
          </li>
        ))}
        <li><LogoutButton compact /></li>
      </ul>
    </div>
  );
}

function DesktopEntry({ status }: { status: Status }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  if (status !== "authed") {
    return (
      <Link href={GUEST_HREF} className={TRIGGER} data-account-entry="guest">
        <PersonIcon /> Account
      </Link>
    );
  }
  return (
    <div ref={rootRef} className="relative" data-account-entry="authed">
      <button ref={toggleRef} type="button" className={TRIGGER} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        <PersonIcon /> Account
        <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div id={panelId} className="absolute right-0 z-50 mt-2 w-60 rounded-lg border border-ink-700 bg-ink-900 p-1.5 shadow-2xl shadow-black/60"
          onClick={(e) => { if ((e.target as HTMLElement).closest("a")) setOpen(false); }}>
          <nav aria-label="Account">
            <ul className="flex flex-col">
              {LINKS.map((l) => (
                <li key={l.href}><Link href={l.href} className="account-menu-item">{l.label}</Link></li>
              ))}
              <li className="mt-1 border-t border-ink-700/80 pt-1"><LogoutButton compact /></li>
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}
