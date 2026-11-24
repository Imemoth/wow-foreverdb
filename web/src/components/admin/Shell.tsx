"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LogoMark } from "@/components/Logo";
import { AdminLogout } from "@/app/admin/AdminLogout";
import { CapBadge, type Capability } from "./primitives";

export const ADMIN_BASE = "/admin";
const NAV: { href: string; label: string; cap: Capability; hint: string }[] = [
  { href: "", label: "Dashboard", cap: "implemented", hint: "Overview" },
  { href: "/articles", label: "Articles / News", cap: "implemented", hint: "Real CMS" },
  { href: "/review", label: "Editorial Review Queue", cap: "implemented", hint: "Approvals & delivery" },
  { href: "/staff", label: "Staff & Roles", cap: "simulated", hint: "No privileged API" },
  { href: "/audit", label: "Audit Log", cap: "implemented", hint: "Authorized read" },
  { href: "/settings", label: "Settings", cap: "implemented", hint: "Session & integration" },
];

export function EnvBanner() {
  return (
    <div role="region" aria-label="Environment" className="sticky top-0 z-40 border-b border-conf-high/50 bg-[repeating-linear-gradient(135deg,#0c2a1c,#0c2a1c_14px,#10341f_14px,#10341f_28px)] px-4 py-2 text-center">
      <p className="text-sm font-bold uppercase tracking-[0.12em] text-conf-high">ISOLATED DISPOSABLE ADMIN — LOCAL BACKEND — NOT PRODUCTION</p>
      <p className="text-xs text-parchment/80">Real CMS persistence and authorization against a throw-away database. No hosted Supabase, no production publication.</p>
    </div>
  );
}

export function AdminShell({ uid, children }: { uid: string; children: ReactNode }) {
  const pathname = usePathname() ?? ADMIN_BASE;
  const rel = pathname.slice(ADMIN_BASE.length).replace(/\/$/, "");
  const [menu, setMenu] = useState(false);
  const active = (href: string): boolean => (href === "" ? rel === "" : rel === href || rel.startsWith(`${href}/`));
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#admin-main" className="skip-link">Skip to Admin content</a>
      <EnvBanner />
      <div className="flex flex-1 flex-col lg:flex-row">
        <nav id="admin-nav" aria-label="Admin" className={`${menu ? "block" : "hidden"} border-b border-ink-700 bg-ink-900 p-3 lg:block lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r lg:p-4`}>
          <div className="mb-5 hidden items-center gap-2 px-2 lg:flex">
            <LogoMark className="h-9 w-9" />
            <div><p className="panel-title text-lg leading-tight">AzerDex</p><p className="text-[0.7rem] uppercase tracking-[0.16em] text-bronze-400">Admin · CMS</p></div>
          </div>
          <ul className="space-y-1">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={`${ADMIN_BASE}${n.href}`} aria-current={active(n.href) ? "page" : undefined} onClick={() => setMenu(false)}
                  className={`block rounded-lg border-l-2 px-3 py-2 no-underline ${active(n.href) ? "border-gold-400 bg-violet-500/15 text-gold-300" : "border-transparent text-parchment hover:bg-ink-800 hover:text-white"}`}>
                  <span className="block text-sm font-semibold">{n.label}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1"><CapBadge kind={n.cap} /></span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-6 px-2 text-xs leading-relaxed text-mist">Legend: <CapBadge kind="implemented" /> backed by the real CMS. <CapBadge kind="simulated" /> informational only. <CapBadge kind="future" /> disabled: no API.</p>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-3 border-b border-ink-700 bg-ink-900/70 px-4 py-2 backdrop-blur">
            <button type="button" className="btn-ghost !min-h-9 lg:hidden" aria-expanded={menu} aria-controls="admin-nav" onClick={() => setMenu((m) => !m)}>
              <span aria-hidden="true">☰</span> Menu
            </button>
            <div className="flex-1" />
            <span className="text-xs text-mist" data-testid="session-identity">Signed in · AAL2 · <code className="text-gold-300">{uid.slice(0, 8)}…</code></span>
            <AdminLogout />
          </div>
          <main id="admin-main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6">{children}</main>
          <footer className="border-t border-ink-700 px-4 py-3 text-center text-xs text-mist">ADM-04 · real Admin CMS UI · isolated development environment · authorization is enforced by the database on every action</footer>
        </div>
      </div>
    </div>
  );
}
