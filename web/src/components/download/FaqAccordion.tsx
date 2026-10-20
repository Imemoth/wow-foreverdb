import Link from "next/link";
import type { ReactNode } from "react";

interface FaqItem {
  q: string;
  a: ReactNode;
}

const FAQ_ITEMS: FaqItem[] = [
  {
    q: "What does the addon collect?",
    a: "Creature loot and skinning, mining and herbalism nodes, fishing and fishing pools, containers/GameObjects, and disenchant results - each with the item, the source, and how it was obtained. It never makes a network request on its own.",
  },
  {
    q: "Does it require the Companion?",
    a: "No. The addon works on its own and exports its observations to SavedVariables. The Companion is what reads that export and offers search, maps, sync and Guildbook on top of it.",
  },
  {
    q: "What does the Companion synchronize?",
    a: "Your own addon's exported observations, so you can search and browse them locally and (for installations that choose to) share them into the wider dataset. Automatic background sync is being rolled out gradually; manual Sync Now is available today.",
  },
  {
    q: "Is an AzerDex account required?",
    a: <>No. Anonymous installations work fully on their own. Account sign-in, registered-device linking and automatic sync are being rolled out separately and are not part of this public beta website.</>,
  },
  {
    q: "What does the public beta currently contain?",
    a: <>Every figure on this build is synthetic sample data from the publication pipeline, not real AzerDex observations yet - see <Link href="/about/data#preview">how the data works</Link> for the full explanation.</>,
  },
  {
    q: "How can I troubleshoot installation or syncing?",
    a: <>Start with <code>/fdb status</code> in-game to confirm the addon is collecting and exporting. The <Link href="/guides/getting-started-with-foreverdb">getting-started guide</Link> covers the addon setup end to end.</>,
  },
  {
    q: "Where can I report issues?",
    a: <>Open an issue on the <a href="https://github.com/Imemoth/wow-foreverdb/issues" rel="noopener noreferrer">GitHub repository</a> - the most reliable way to reach the project today.</>,
  },
];

/**
 * Native <details>/<summary> accordion (P2-E Phase 5) - same pattern already used for
 * Database's mobile filter disclosure and the Guides reader's table of contents: no JS,
 * keyboard-toggleable by default, and the expanded/collapsed state is announced for
 * free by assistive tech via the native <summary> semantics.
 */
export function FaqAccordion() {
  return (
    <div className="space-y-2">
      {FAQ_ITEMS.map((item) => (
        <details key={item.q} className="panel group p-0">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-semibold text-parchment marker:content-none [&::-webkit-details-marker]:hidden">
            {item.q}
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-mist transition group-open:rotate-180" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <div className="px-4 pb-4 text-sm text-mist">{item.a}</div>
        </details>
      ))}
    </div>
  );
}

/**
 * Discord entry (P2-E Phase 5): a verified owner invite is not available to this
 * session, so this renders a clearly non-clickable, documented placeholder rather than
 * a fabricated invite link. To activate: set `DISCORD_INVITE_URL` below to the owner's
 * real, verified invite and change this `<span>` to an `<a>` - no other change needed.
 */
const DISCORD_INVITE_URL: string | null = null;

export function SupportLinks() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <a
        href="https://github.com/Imemoth/wow-foreverdb/issues"
        rel="noopener noreferrer"
        className="btn-primary justify-center"
      >
        Report an issue on GitHub
      </a>
      {DISCORD_INVITE_URL ? (
        <a href={DISCORD_INVITE_URL} rel="noopener noreferrer" className="btn-ghost justify-center">
          Join the Discord
        </a>
      ) : (
        <span
          aria-disabled="true"
          title="Discord invite not yet configured"
          className="flex cursor-not-allowed items-center justify-center rounded-md border border-ink-700 px-4 py-2 text-sm font-medium text-mist/60"
        >
          Discord community (coming soon)
        </span>
      )}
    </div>
  );
}
