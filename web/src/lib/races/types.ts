import type { HistoryEntry, SourceRef } from "../versioned/types";

export type Faction = "alliance" | "horde";
export type AbilityType = "active" | "passive";

export interface ClassAvailability {
  classId: string;
  name: string;
  /** True for race/class combinations Blizzard documents as new in Forever. */
  isNew: boolean;
}

export interface AbilityView {
  id: string;
  name: string;
  type: AbilityType;
  description: string;
  /** Plain text such as "2 min"; null when not documented. */
  cooldown: string | null;
  duration: string | null;
  /** Conditions, limits and extra numbers worth knowing. */
  details: string[];
  /** Races sharing this ability. */
  races: string[];
  active: boolean;
  /** Chronological, oldest first. */
  history: HistoryEntry[];
  sources: SourceRef[];
}

export interface RaceGuide {
  id: string;
  slug: string;
  name: string;
  faction: Faction;
  summary: string;
  classes: ClassAvailability[];
  active: AbilityView[];
  passive: AbilityView[];
  /** Abilities that used to belong to this race and no longer do. */
  retired: AbilityView[];
  /** Newest first, one row per historical change affecting this race (excluding the baseline). */
  changes: Array<{ ability: AbilityView; entry: HistoryEntry }>;
  latestUpdate: string | null;
  /** Evidence summary for the provenance box. */
  evidence: { clientVerified: number; official: number; pending: number };
}
