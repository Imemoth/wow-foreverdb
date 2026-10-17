import Link from "next/link";
import { LogoMark } from "./Logo";

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
  // its configuration or session state — enforced by a static test, not just a convention. So the
  // header cannot know whether sign-in is enabled or whether the visitor is signed in; it only
  // ever links to the real /account route. When the feature is off, that route's own gate decides
  // (app/account/layout.tsx answers "not found") — the disabled state is enforced there, not hidden here.
  return (
    <header className="border-b border-ink-700/80 bg-ink-900/80 backdrop-blur supports-[backdrop-filter]:bg-ink-900/60">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="AzerDex home">
          <LogoMark />
          <span className="font-[family-name:var(--font-display)] text-xl font-bold tracking-wide text-gold-300">
            Azer<span className="text-parchment">Dex</span>
          </span>
        </Link>
        <nav aria-label="Primary" className="order-3 w-full sm:order-none sm:w-auto">
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
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <form action="/database" method="get" role="search" className="flex min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="header-q" className="sr-only">Search the database</label>
            <input id="header-q" name="q" type="search" maxLength={80} minLength={2} autoComplete="off"
              placeholder="Search items, creatures, nodes…" className="field w-full text-sm" />
          </form>
          <Link href="/account" className="btn-ghost text-sm">Account</Link>
        </div>
      </div>
    </header>
  );
}
