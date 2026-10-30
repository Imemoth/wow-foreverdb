"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { getJson } from "@/lib/account/client";
import { createHeaderStatusStore, type HeaderAccountStatus } from "@/lib/account/header-status";
import { LogoutButton } from "./LogoutButton";
import { ChevronDownIcon, InstallIcon, LogInIcon, MonitorIcon, PersonIcon, UserPlusIcon } from "./icons";

type Status = HeaderAccountStatus;

const GUEST_LINKS = [
  { href: "/account/login", label: "Log in", Icon: LogInIcon },
  { href: "/account/register", label: "Register", Icon: UserPlusIcon },
];

const MEMBER_LINKS = [
  { href: "/account", label: "My account", Icon: PersonIcon },
  { href: "/account/installations", label: "My installations", Icon: InstallIcon },
  { href: "/account/devices", label: "Devices", Icon: MonitorIcon },
];

/**
 * Signed-in state for the header. The session cookie is HttpOnly and Path=/account, so the page cannot read it and
 * public pages never receive it; /account/api/me (same-origin, no token in JavaScript) is the only signal. Until it
 * answers (and whenever it fails) the menu offers the guest items, which are always safe: a signed-in visitor who
 * follows one is redirected to /account by the login and register pages, never shown the form. The answer is shared by
 * all entries on the page (module-level store), so the mobile menu, which mounts when opened, shows it immediately.
 */
const store = createHeaderStatusStore(() => getJson("/account/api/me"));

function useAccountStatus(): Status {
  useEffect(() => store.ensureLoaded(), []);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

const TRIGGER =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-gold-500/50 bg-ink-950/60 px-2.5 py-1.5 text-sm font-medium text-parchment no-underline transition hover:border-gold-400 hover:text-violet-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400";

/** The items of the dropdown: the same list on desktop and inside the mobile menu. */
function AccountItems({ status }: { status: Status }) {
  if (status !== "authed") {
    return (
      <ul className="flex flex-col">
        {GUEST_LINKS.map(({ href, label, Icon }) => (
          <li key={href}><Link href={href} className="account-menu-item"><Icon className="h-4 w-4 text-violet-300" />{label}</Link></li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex flex-col">
      {MEMBER_LINKS.map(({ href, label, Icon }) => (
        <li key={href}><Link href={href} className="account-menu-item"><Icon className="h-4 w-4 text-violet-300" />{label}</Link></li>
      ))}
      <li className="mt-1 border-t border-ink-700/80 pt-1"><LogoutButton compact /></li>
    </ul>
  );
}

export function HeaderAccountMenu({ variant }: { variant: "desktop" | "mobile" }) {
  const status = useAccountStatus();
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

  const mobile = variant === "mobile";
  const close = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a")) setOpen(false);
  };

  return (
    <div ref={rootRef} className={mobile ? "mt-1 border-t border-ink-700/80 pt-1" : "relative"} data-account-entry={status === "authed" ? "authed" : "guest"}>
      <button
        ref={toggleRef}
        type="button"
        className={mobile ? "flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-parchment hover:bg-ink-800 hover:text-violet-300" : TRIGGER}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <PersonIcon /> Account
        <ChevronDownIcon className={`h-3.5 w-3.5 transition ${mobile ? "ml-auto" : ""} ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          id={panelId}
          className={mobile
            ? "mt-1 rounded-lg border border-violet-700/40 bg-ink-950/70 p-1.5"
            : "absolute right-0 z-50 mt-2 w-60 rounded-xl border border-violet-700/40 bg-ink-900 p-1.5 shadow-2xl shadow-black/60"}
          onClick={close}
        >
          <nav aria-label="Account"><AccountItems status={status} /></nav>
        </div>
      )}
    </div>
  );
}
