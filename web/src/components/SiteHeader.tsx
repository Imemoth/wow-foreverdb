import Link from "next/link";
import { SUPPORT_URL } from "@/lib/support-link";
import { LogoMark } from "./Logo";
import { MobileNav } from "./MobileNav";

const NAV = [
  { href: "/database", label: "Database" },
  { href: "/zones", label: "Zones" },
  { href: "/guides", label: "Guides" },
  { href: "/news", label: "News" },
  { href: "/blog", label: "Blog" },
  { href: "/download", label: "Download" },
];

export function SiteHeader() {
  // ADR-015 (account boundary): this file stays outside the account zone and never references
  // its configuration or session state — enforced by a static test, not just a convention. For
  // the current public-beta scope, Account Auth is disabled, which made a global, state-agnostic
  // "/account" link here misleading (it always rendered, 404'd when visited). Since this file
  // cannot safely check whether sign-in is enabled without crossing the boundary, the fix is to
  // remove the entry point here rather than make it conditional - the real /account app, its own
  // authenticated nav (AccountNavLinks.tsx) and its fail-closed 404 gate are all untouched.
  return (
    <header className="border-b border-ink-700/80 bg-ink-900/80 backdrop-blur supports-[backdrop-filter]:bg-ink-900/60">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-2.5 sm:py-3">
        <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="AzerDex home">
          <LogoMark />
          <span className="font-[family-name:var(--font-display)] text-xl font-bold tracking-wide text-gold-300">
            Azer<span className="text-parchment">Dex</span>
          </span>
        </Link>
        <nav aria-label="Primary" className="hidden sm:block sm:w-auto">
          <ul className="flex flex-wrap gap-1 text-sm">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="rounded-md px-2.5 py-1.5 text-parchment no-underline hover:bg-ink-800 hover:text-violet-300">
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {/*
          Tablet (sm-lg, ~640-1023px): the logo+nav row alone is already close to full width, so
          giving the search field `flex-1` here left it squeezed into whatever sliver of the row
          remained - a narrow, right-aligned field with its placeholder clipped. `w-full` makes it
          claim the whole flex line, which this flex-wrap row has no room for, so it wraps onto its
          own full-width second row instead. At `lg:` and up there's room for everything inline, so
          it reverts to `w-auto`/`max-w-xs`, right-aligned on the same row as the logo+nav - the
          original wide-desktop layout, unchanged.
        */}
        <div className="hidden w-full items-center gap-2 sm:flex lg:ml-auto lg:w-auto">
          <form action="/database" method="get" role="search" className="flex min-w-0 flex-1 lg:max-w-xs lg:flex-none">
            <label htmlFor="header-q" className="sr-only">Search the database</label>
            <input id="header-q" name="q" type="search" maxLength={80} minLength={2} autoComplete="off"
              placeholder="Search items, creatures, nodes…" className="field w-full text-sm" />
          </form>
          {/* Visually secondary to primary navigation and search: smaller, outlined rather than
              filled, and placed last in this top-right cluster. A plain external link - no widget,
              script or tracking. */}
          <a
            href={SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 whitespace-nowrap rounded-md border border-gold-500/30 bg-ink-950/60 px-2.5 py-1.5 text-xs font-medium text-mist no-underline transition hover:border-gold-500/60 hover:text-violet-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
          >
            ☕ Support
          </a>
        </div>
        {/* Mobile-only compact row: full nav/search collapse into a search shortcut and the hamburger menu. */}
        <div className="ml-auto flex items-center gap-1 sm:hidden">
          <Link href="/database" aria-label="Search the database"
            className="flex h-11 w-11 items-center justify-center rounded-md text-parchment hover:bg-ink-800 hover:text-violet-300">
            <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </Link>
          <MobileNav />
        </div>
      </div>
    </header>
  );
}
