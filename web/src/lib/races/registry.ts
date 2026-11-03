import baselineFile from "@/data/races/forever/baseline/2026-09-22.json";
import sourcesFile from "@/data/races/forever/sources.json";
import c0924 from "@/data/races/forever/changes/2026-09-24.json";
import c1001 from "@/data/races/forever/changes/2026-10-01.json";
import c1015 from "@/data/races/forever/changes/2026-10-15.json";
import c1026 from "@/data/races/forever/changes/2026-10-26.json";
import c1027 from "@/data/races/forever/changes/2026-10-27.json";
import c1028 from "@/data/races/forever/changes/2026-10-28.json";
import { BaselineSchema, ChangeFileSchema, SourceCatalogSchema } from "../versioned/schema";
import { resolveVersioned } from "../versioned/resolve";
import type { Baseline, ChangeFile, SourceCatalog } from "../versioned/types";
import { buildRaceGuides } from "./build";
import { RACE_IDENTITIES } from "./identities";
import type { RaceGuide } from "./types";

/**
 * The racial-ability dataset the site serves. To add a newly verified change: add a dated file under
 * src/data/races/forever/changes/ (never edit an existing record), import it below in chronological order and run the tests.
 * The current definitions are *derived* from baseline + changes at load; nothing is stored twice. See docs/web/race-guides.md.
 */
export const RACE_SOURCES = SourceCatalogSchema.parse(sourcesFile) as SourceCatalog;
export const RACE_BASELINE = BaselineSchema.parse(baselineFile) as Baseline;
export const RACE_CHANGE_FILES: readonly ChangeFile[] = [c0924, c1001, c1015, c1026, c1027, c1028].map((f) => ChangeFileSchema.parse(f) as ChangeFile);

export const RACE_STATE = resolveVersioned(RACE_BASELINE, RACE_CHANGE_FILES, RACE_SOURCES);
export const RACE_GUIDES: readonly RaceGuide[] = buildRaceGuides(RACE_STATE, RACE_IDENTITIES);

export const raceNewFlags: Readonly<Record<string, boolean>> = Object.fromEntries(RACE_IDENTITIES.map((r) => [r.id, r.isNewRace]));

export function getRaceGuide(slug: string): RaceGuide | null {
  return RACE_GUIDES.find((g) => g.slug === slug) ?? null;
}

export const racePath = (slug: string) => `/guides/races/${slug}`;
