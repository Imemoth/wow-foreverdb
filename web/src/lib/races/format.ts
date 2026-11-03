import type { ChangeType, Evidence, SourceKind } from "../versioned/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-26" -> "26 Oct 2026". Pure string handling: no time zone or locale can shift the day. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export const EVIDENCE_LABEL: Record<Evidence, string> = {
  "client-verified": "Verified in the game client",
  official: "Blizzard-documented",
  corroborated: "Community-reported",
  unverified: "Unverified",
};

export const CHANGE_LABEL: Record<ChangeType | "baseline", string> = {
  baseline: "Earliest documented",
  added: "Added",
  modified: "Changed",
  renamed: "Renamed",
  removed: "Removed",
  restored: "Restored",
  documented: "Community detail",
};

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  "client-data": "Game client data",
  "official-dev-notes": "Blizzard development notes",
  "official-article": "Blizzard article",
  community: "Community site",
};

export const FACTION_LABEL = { alliance: "Alliance", horde: "Horde" } as const;
