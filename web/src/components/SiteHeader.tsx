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
  return (
    <header className="border-b border-ink-700/80 bg-ink-950/80 backdrop-blur supports-[backdrop-filter]:bg-ink-950/60">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2.5 no-underline" aria-label="ForeverDB home">
          <LogoMark />
          <span className="font-[family-name:var(--font-display)] text-xl font-bold tracking-wide text-gold-300">
            Forever<span className="text-parchment">DB</span>
          </span>
        </Link>
        <nav aria-label="Primary" className="order-3 w-full sm:order-none sm:w-auto">
          <ul className="flex flex-wrap gap-1 text-sm">
            {NAV.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="rounded-md px-2.5 py-1.5 text-parchment no-underline hover:bg-ink-800 hover:text-gold-300">
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <form action="/database" method="get" role="search" className="ml-auto flex min-w-0 flex-1 justify-end sm:max-w-xs">
          <label htmlFor="header-q" className="sr-only">Search the database</label>
          <input id="header-q" name="q" type="search" maxLength={80} minLength={2} autoComplete="off"
            placeholder="Search items, creatures, nodes…" className="field w-full text-sm" />
        </form>
      </div>
    </header>
  );
}
