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
import iconsFile from "@/data/talents/forever/1.60.1.70630/icons.json";
import textFile from "@/data/talents/forever/1.60.1.70630/text.json";
import { resolveTalentIcons, talentIconBase } from "./icons";
import { applyTalentText, type TextStatus } from "./text";
import type { TalentClassData, TalentIconManifest, TalentManifest, TalentTextFile } from "./types";

/**
 * The talent dataset the site currently serves. To move to a newer game build, regenerate the JSON folder with
 * scripts/import-talent-catalog.mjs and change these imports (see docs/web/class-guides-talents.md).
 * A class that is missing from this table (or not yet verified) shows as "unavailable" - never as guessed data.
 * Validity of every file is enforced by tests/unit/talents-data.test.ts.
 */
const FILES: Record<string, unknown> = { warrior, paladin, hunter, rogue, priest, shaman, mage, warlock, druid };

export const TALENT_MANIFEST = manifest as unknown as TalentManifest;
export const TALENT_BUILD = TALENT_MANIFEST.build;
export const TALENT_TEXT = textFile as unknown as TalentTextFile;
export const TALENT_ICONS = iconsFile as unknown as TalentIconManifest;

// Description text is merged in once, and only when its build equals the dataset build (see text.ts).
const MERGED = new Map<string, { data: TalentClassData; text: TextStatus }>(
  Object.entries(FILES).map(([id, raw]) => {
    const { data, status } = applyTalentText(raw as TalentClassData, TALENT_TEXT);
    return [id, { data, text: status }];
  }),
);

export function getTalentData(classId: string): TalentClassData | null {
  return MERGED.get(classId)?.data ?? null;
}

/** Whether description text is merged for the class, was refused (build mismatch) or does not exist. */
export function getTextStatus(classId: string): TextStatus {
  return MERGED.get(classId)?.text ?? { state: "none" };
}

/** Icon URLs for a class (talent id -> URL). Empty unless the CDN icon source is switched on and the manifest matches the build. */
export function getTalentIcons(data: TalentClassData, env: Readonly<Record<string, string | undefined>> = process.env): Record<number, string> {
  return resolveTalentIcons(data, TALENT_ICONS, talentIconBase(env));
}

export function availableTalentClasses(): string[] {
  return Object.keys(FILES);
}
