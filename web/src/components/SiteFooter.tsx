import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-ink-700/80 bg-ink-950">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-mist md:grid-cols-3">
        <div>
          <p className="font-[family-name:var(--font-display)] text-base text-gold-300">ForeverDB</p>
          <p className="mt-2 leading-relaxed">
            A community-collected, observation-based database for World of Warcraft: Forever. Percentages are
            <strong className="text-parchment"> observed sample rates</strong>, not official drop chances.
          </p>
        </div>
        <nav aria-label="Footer">
          <ul className="grid grid-cols-2 gap-2">
            <li><Link href="/about/data">How the data works</Link></li>
            <li><Link href="/about/privacy">Privacy</Link></li>
            <li><Link href="/download">Addon &amp; Companion</Link></li>
            <li><Link href="/news/rss.xml">RSS feed</Link></li>
            <li><Link href="/zones">All zones</Link></li>
            <li><a href="https://github.com/Imemoth/wow-foreverdb" rel="noopener noreferrer">Source on GitHub</a></li>
          </ul>
        </nav>
        <p className="leading-relaxed">
          ForeverDB is an independent fan project and is not affiliated with or endorsed by Blizzard Entertainment.
          World of Warcraft and related names are trademarks of Blizzard Entertainment, Inc. No Blizzard artwork is
          redistributed by this site.
        </p>
      </div>
    </footer>
  );
}
