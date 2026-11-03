import type { Evidence, HistoryEntry, SourceRef } from "../versioned/types";

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
  /** Details reported by community sites that Blizzard has not published. */
  communityNotes: string[];
  /** How well each shown field is backed (keys: description, cooldown, duration, details, communityNotes). */
  evidence: Partial<Record<string, Evidence>>;
  /** Races sharing this ability. */
  races: string[];
  active: boolean;
  /** Chronological, oldest first. */
  history: HistoryEntry[];
  sources: SourceRef[];
}

export interface RaceChange {
  ability: AbilityView;
  entry: HistoryEntry;
  /** The ability's description before this entry (null for the earliest documented entry). */
  before: string | null;
}

export interface RaceGuide {
  id: string;
  slug: string;
  name: string;
  faction: Faction;
  summary: string;
  classes: ClassAvailability[];
  /** Sources that document the class list (Blizzard's race/class overview; for Skyborne also the Skyborne article). */
  classSources: SourceRef[];
  active: AbilityView[];
  passive: AbilityView[];
  /** Abilities that used to belong to this race and no longer do. */
  retired: AbilityView[];
  /** Newest first, one row per historical change affecting this race (excluding the baseline). */
  changes: RaceChange[];
  /** The earliest documented definition of every ability that is no longer current. */
  earliest: RaceChange[];
  latestUpdate: string | null;
  /** Evidence summary for the provenance box. */
  evidence: { clientVerified: number; official: number; community: number; pending: number };
}
