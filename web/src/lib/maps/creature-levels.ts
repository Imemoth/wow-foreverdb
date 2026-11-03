import type { LocationPoint, SourceDetail } from "@/lib/data/types";

/**
 * Creature level helpers. Levels are NEVER invented: the options come from the levels actually present in the published source detail
 * (its variants and its aggregated locations). Each level is its own statistical sample and is never merged with another.
 */
export interface LevelOption {
  level: number;
  label: string;
  /** Total observations of that level's own variant (its own sample, never summed across levels). */
  observations: number;
  /** Published aggregated map cells of that level, over all zones. */
  cells: number;
}

/** 0 is the historical "level unknown" variant. */
export const levelLabel = (level: number): string => (level > 0 ? `Level ${level}` : "Level ? (historical)");

export function levelOptions(detail: Pick<SourceDetail, "variants" | "locations">): LevelOption[] {
  const cells = new Map<number, number>();
  for (const l of detail.locations) cells.set(l.level, (cells.get(l.level) ?? 0) + 1);
  const obs = new Map<number, number>();
  for (const v of detail.variants) obs.set(v.level, (obs.get(v.level) ?? 0) + v.totalObservations);
  const levels = [...new Set([...obs.keys(), ...cells.keys()])].filter((l) => Number.isInteger(l) && l >= 0 && l <= 999);
  // ascending, the unknown (0) level last
  levels.sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  return levels.map((level) => ({ level, label: levelLabel(level), observations: obs.get(level) ?? 0, cells: cells.get(level) ?? 0 }));
}

/** A `?level=` / hash value is honoured only when it names an observed level; anything else is ignored (never an error). */
export function parseLevelParam(raw: string | string[] | null | undefined, options: readonly LevelOption[]): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || !/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return options.some((o) => o.level === n) ? n : null;
}

/** `#level-7` (the anchor the rest of the site links to) -> 7, only when observed. */
export function levelFromHash(hash: string, options: readonly LevelOption[]): number | null {
  const m = /^#level-(\d{1,3})$/.exec(hash);
  return m ? parseLevelParam(m[1], options) : null;
}

export function filterByLevel<T extends { level: number }>(items: readonly T[], level: number | null): T[] {
  return level == null ? [...items] : items.filter((i) => i.level === level);
}

export const locationsOfLevel = (locations: readonly LocationPoint[], level: number | null) => filterByLevel(locations, level);
