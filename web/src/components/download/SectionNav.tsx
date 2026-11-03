const SECTIONS = [
  { href: "#overview", label: "Overview" },
  { href: "#addon", label: "In-game Addon" },
  { href: "#companion", label: "Windows Companion" },
  { href: "#how-it-works", label: "How It Works" },
  { href: "#installation", label: "Installation" },
  { href: "#faq", label: "FAQ & Support" },
];

/**
 * Plain semantic anchor navigation (P2-E Phase 1.2) - native in-page `#` links, no
 * scrollspy, no client component, no extra dependency. `flex-wrap` keeps every link
 * reachable at any width instead of requiring horizontal scroll, so mobile never gets
 * a nav that covers content or overflows the viewport.
 */
export function SectionNav() {
  return (
    <nav aria-label="Addon & Companion sections" className="panel flex flex-wrap gap-x-1 gap-y-1 p-2">
      {SECTIONS.map((s) => (
        <a
          key={s.href}
          href={s.href}
          className="rounded-md px-3 py-2 text-sm font-medium text-parchment no-underline hover:bg-ink-800 hover:text-violet-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
