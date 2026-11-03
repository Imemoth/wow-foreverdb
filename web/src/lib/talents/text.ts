import { GAP_CODES } from "./tooltip";
import type { Talent, TalentClassData, TalentRankText, TalentTextEntry, TalentTextFile, TextSegment } from "./types";

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
  | { state: "withheld" }
  | { state: "mismatch"; textBuild: string | null }
  | { state: "applied"; build: string; source: NonNullable<TalentTextFile["source"]>; covered: number; complete: number; total: number };

/**
 * Publication gate. The description text is Blizzard game text; until the owner has decided it may be published on the
 * production site it is merged everywhere EXCEPT a production deployment, where AZERDEX_TALENT_TEXT=1 switches it on.
 */
export const talentTextPublished = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.FOREVERDB_DEPLOYMENT !== "production" || env.AZERDEX_TALENT_TEXT === "1";

const MAX_TEXT = 1200;
const GAP_SET: ReadonlySet<string> = new Set(GAP_CODES);
const MAX_SEGMENTS = 80;

const usableSegments = (segs: unknown): segs is TextSegment[] =>
  Array.isArray(segs) &&
  segs.length > 0 &&
  segs.length <= MAX_SEGMENTS &&
  segs.every((g) => (typeof g === "string" ? g.length <= MAX_TEXT : !!g && typeof g === "object" && typeof (g as { g?: unknown }).g === "string" && GAP_SET.has((g as { c?: string }).c ?? "")));

/** Rank text of a v2 entry, only when it belongs to this talent (same spell) and has the right number of ranks. */
function rankTextOf(entry: TalentTextEntry, t: Talent): TalentRankText[] | null {
  if (entry.spellId !== t.spellId || typeof entry.templateHash !== "string" || !/^[0-9a-f]{12}$/.test(entry.templateHash)) return null;
  if (entry.segments !== undefined) {
    return usableSegments(entry.segments) ? [{ segments: entry.segments, complete: entry.segments.every((g) => typeof g === "string") }] : null;
  }
  const ranks = entry.ranks;
  if (!Array.isArray(ranks) || ranks.length !== t.maxRank || !ranks.every((r) => r && usableSegments(r.segments))) return null;
  return ranks.map((r) => ({ segments: r.segments, complete: r.segments.every((g) => typeof g === "string") }));
}

/** The description of a talent at a rank (rank 0 is shown as rank 1). */
export function textForRank(t: Pick<Talent, "rankText">, rank: number): TalentRankText | null {
  const list = t.rankText;
  if (!list) return null;
  return list.length === 1 ? list[0]! : (list[Math.max(1, rank) - 1] ?? null);
}
const usable = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= MAX_TEXT;

export function applyTalentText(data: TalentClassData, text: TalentTextFile, published = true): { data: TalentClassData; status: TextStatus } {
  const total = data.trees.reduce((n, t) => n + t.talents.length, 0);
  if (text.build === null || Object.keys(text.talents).length === 0 || text.source === null) return { data, status: { state: "none" } };
  if (text.build !== data.build.version) return { data, status: { state: "mismatch", textBuild: text.build } };
  if (!published) return { data, status: { state: "withheld" } };

  let covered = 0;
  let complete = 0;
  const trees = data.trees.map((tree) => ({
    ...tree,
    talents: tree.talents.map((t): Talent => {
      const entry = Object.hasOwn(text.talents, String(t.id)) ? text.talents[String(t.id)] : undefined;
      if (!entry) return t;
      const rankText = text.schema === "azerdex.talent-text/2" ? rankTextOf(entry, t) : null;
      if (rankText) {
        covered++;
        if (rankText.every((r) => r.complete)) complete++;
        return { ...t, rankText };
      }
      if (text.schema === "azerdex.talent-text/2") return t;
      const perRank = entry.descriptions;
      if (Array.isArray(perRank) && perRank.length === t.maxRank && perRank.every(usable)) {
        covered++;
        complete++;
        return { ...t, descriptions: perRank };
      }
      if (usable(entry.description)) {
        covered++;
        complete++;
        return { ...t, description: entry.description };
      }
      return t;
    }),
  }));
  return covered === 0
    ? { data, status: { state: "none" } }
    : { data: { ...data, trees }, status: { state: "applied", build: text.build, source: text.source, covered, complete, total } };
}
