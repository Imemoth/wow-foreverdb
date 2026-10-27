import druid from "@/data/talents/forever/1.60.1.70630/druid.json";
import hunter from "@/data/talents/forever/1.60.1.70630/hunter.json";
import mage from "@/data/talents/forever/1.60.1.70630/mage.json";
import manifest from "@/data/talents/forever/1.60.1.70630/manifest.json";
import paladin from "@/data/talents/forever/1.60.1.70630/paladin.json";
import priest from "@/data/talents/forever/1.60.1.70630/priest.json";
import rogue from "@/data/talents/forever/1.60.1.70630/rogue.json";
import shaman from "@/data/talents/forever/1.60.1.70630/shaman.json";
import warlock from "@/data/talents/forever/1.60.1.70630/warlock.json";
import warrior from "@/data/talents/forever/1.60.1.70630/warrior.json";
import type { TalentClassData, TalentManifest } from "./types";

/**
 * The talent dataset the site currently serves. To move to a newer game build, regenerate the JSON folder with
 * scripts/import-talent-catalog.mjs and change these imports (see docs/web/class-guides-talents.md).
 * A class that is missing from this table (or not yet verified) shows as "unavailable" - never as guessed data.
 * Validity of every file is enforced by tests/unit/talents-data.test.ts.
 */
const FILES: Record<string, unknown> = { warrior, paladin, hunter, rogue, priest, shaman, mage, warlock, druid };

export const TALENT_MANIFEST = manifest as unknown as TalentManifest;
export const TALENT_BUILD = TALENT_MANIFEST.build;

export function getTalentData(classId: string): TalentClassData | null {
  return (Object.hasOwn(FILES, classId) ? (FILES[classId] as TalentClassData) : null);
}

export function availableTalentClasses(): string[] {
  return Object.keys(FILES);
}
