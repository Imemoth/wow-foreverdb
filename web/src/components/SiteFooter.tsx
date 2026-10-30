import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-ink-700/80 bg-ink-950">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-mist md:grid-cols-3">
        <div>
          <p className="font-[family-name:var(--font-display)] text-base text-gold-300">AzerDex</p>
          <p className="mt-1 text-xs uppercase tracking-[0.2em] text-mist">Know Your World.</p>
          <p className="mt-2 leading-relaxed">
            A community-collected, observation-based database for World of Warcraft: Forever, built from the ForeverDB
            addon and Companion. Percentages are <strong className="text-parchment">observed sample rates</strong>,
            not official drop chances.
          </p>
        </div>
        <nav aria-label="Footer">
          <ul className="grid grid-cols-2 gap-2">
            <li><Link href="/about/data">How the data works</Link></li>
            <li><Link href="/about/privacy">Privacy</Link></li>
            <li><Link href="/addon-companion">Addon &amp; Companion</Link></li>
            <li><Link href="/news/rss.xml">RSS feed</Link></li>
            <li><Link href="/zones">All zones</Link></li>
            <li><a href="https://github.com/Imemoth/wow-foreverdb" rel="noopener noreferrer">Source on GitHub</a></li>
          </ul>
        </nav>
        {/* "Independent, free, non-commercial fan project" is an explicit, owner-approved designation. Changes to project
            ownership, licensing, commercial status or monetization wording need explicit owner approval. */}
        <p className="leading-relaxed">
          AzerDex is an independent, free, non-commercial fan project and is not affiliated with or endorsed by Blizzard Entertainment, Inc.
          World of Warcraft and related names are trademarks or registered trademarks of Blizzard Entertainment, Inc.
          &copy; Blizzard Entertainment, Inc. All rights reserved. Zone map images, talent and ability names, descriptions
          and icons come from World of Warcraft: Forever and remain Blizzard&apos;s property; AzerDex claims no rights to them.
          Class and race illustrations, class emblems, talent tree backgrounds and homepage artwork are not game assets.
        </p>
      </div>
    </footer>
  );
}
