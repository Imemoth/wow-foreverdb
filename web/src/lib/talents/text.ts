import type { Talent, TalentClassData, TalentTextFile } from "./types";

/**
 * Merges the optional per-build description text into a class's talent data.
 *
 * The overlay is trusted only when it was extracted from the SAME game build as the talent dataset: text from any other
 * build (older or newer) is ignored as a whole, never mixed in and shown as verified. Individual entries that do not fit
 * their talent (wrong rank count, empty or oversized text) are skipped, so a malformed entry can only ever mean "no
 * description", which the UI states honestly.
 */

export type TextStatus =
  | { state: "none" }
  | { state: "mismatch"; textBuild: string | null }
  | { state: "applied"; build: string; source: NonNullable<TalentTextFile["source"]>; covered: number; total: number };

const MAX_TEXT = 1200;
const usable = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= MAX_TEXT;

export function applyTalentText(data: TalentClassData, text: TalentTextFile): { data: TalentClassData; status: TextStatus } {
  const total = data.trees.reduce((n, t) => n + t.talents.length, 0);
  if (text.build === null || Object.keys(text.talents).length === 0 || text.source === null) return { data, status: { state: "none" } };
  if (text.build !== data.build.version) return { data, status: { state: "mismatch", textBuild: text.build } };

  let covered = 0;
  const trees = data.trees.map((tree) => ({
    ...tree,
    talents: tree.talents.map((t): Talent => {
      const entry = Object.hasOwn(text.talents, String(t.id)) ? text.talents[String(t.id)] : undefined;
      if (!entry) return t;
      const perRank = entry.descriptions;
      if (Array.isArray(perRank) && perRank.length === t.maxRank && perRank.every(usable)) {
        covered++;
        return { ...t, descriptions: perRank };
      }
      if (usable(entry.description)) {
        covered++;
        return { ...t, description: entry.description };
      }
      return t;
    }),
  }));
  return covered === 0
    ? { data, status: { state: "none" } }
    : { data: { ...data, trees }, status: { state: "applied", build: text.build, source: text.source, covered, total } };
}
