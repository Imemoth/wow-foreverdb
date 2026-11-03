/**
 * Centralized, typed media-slot registry for the /download screenshot galleries
 * (P2-E Phase 3). A "slot" is a named, permanent placement in the page layout -
 * it exists whether or not a real screenshot has been supplied yet. Each slot
 * carries its own stable id, the filename it expects once an image exists, and an
 * optional `asset` path: when `asset` is unset the gallery renders an intentional
 * placeholder (see MediaSlotGallery.tsx); when a real reviewed screenshot is ready,
 * dropping the file at the stated path under `public/download/screenshots/` and
 * setting `asset` here is the ONLY change needed - no layout or component edit.
 *
 * Do not add a slot whose `asset` points at a file that does not exist in
 * `public/` - the gallery's own regression test asserts every configured `asset`
 * resolves to a real file, specifically to prevent a broken-image request in
 * production.
 */

export type MediaSlotGroup = "addon" | "companion";

export interface MediaSlot {
  /** Stable identifier - do not reuse or renumber once published; it is referenced
   *  by tests and by the lightbox's URL-free focus-return bookkeeping. */
  id: string;
  group: MediaSlotGroup;
  title: string;
  description: string;
  /** Expected filename once a real screenshot exists, relative to
   *  `public/download/screenshots/` - documented so a future contributor knows
   *  exactly where to put the file without reading this source. */
  intendedFilename: string;
  /** Set only once a real, reviewed screenshot has been committed at
   *  `public/download/screenshots/<intendedFilename>`. Leave undefined for a
   *  placeholder slot - never point this at a mock/synthetic UI mockup. */
  asset?: string;
}

export const ADDON_MEDIA_SLOTS: MediaSlot[] = [
  {
    id: "addon-loot-tooltip",
    group: "addon",
    title: "Loot collection & tooltip",
    description: "The in-game tooltip addition showing observed sources and sample-based rates for an item.",
    intendedFilename: "addon-loot-tooltip.webp",
  },
  {
    id: "addon-gathering",
    group: "addon",
    title: "Gathering observations",
    description: "A mining, herbalism or fishing node being recorded as it is gathered.",
    intendedFilename: "addon-gathering.webp",
  },
  {
    id: "addon-session-hud",
    group: "addon",
    title: "Session Tracker HUD",
    description: "The compact in-game HUD showing XP, gold and session timing while you play.",
    intendedFilename: "addon-session-hud.webp",
  },
  {
    id: "addon-collector-status",
    group: "addon",
    title: "Collector status",
    description: "The `/fdb status` command output: export size, last observation and collector health.",
    intendedFilename: "addon-collector-status.webp",
  },
];

export const COMPANION_MEDIA_SLOTS: MediaSlot[] = [
  {
    id: "companion-database-search",
    group: "companion",
    title: "Database search",
    description: "Searching your own collected observations from the Windows Companion.",
    intendedFilename: "companion-database-search.webp",
  },
  {
    id: "companion-interactive-map",
    group: "companion",
    title: "Interactive map",
    description: "A zone map built from your own game install, with markers for observed sources.",
    intendedFilename: "companion-interactive-map.webp",
  },
  {
    id: "companion-sync-dashboard",
    group: "companion",
    title: "Synchronization dashboard",
    description: "SavedVariables and sync health status for a tracked installation.",
    intendedFilename: "companion-sync-dashboard.webp",
  },
  {
    id: "companion-guildbook",
    group: "companion",
    title: "Guildbook",
    description: "The roster and recipe view built from your guild's shared observations.",
    intendedFilename: "companion-guildbook.webp",
  },
];

export const MEDIA_SLOTS: MediaSlot[] = [...ADDON_MEDIA_SLOTS, ...COMPANION_MEDIA_SLOTS];

export function slotsFor(group: MediaSlotGroup): MediaSlot[] {
  return MEDIA_SLOTS.filter((s) => s.group === group);
}
