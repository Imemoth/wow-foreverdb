import type { TalentEngine } from "./engine";
import type { Allocation, TalentClassData } from "./types";

/**
 * Shareable build codes: `<layoutHash>.<tree 1 ranks>-<tree 2 ranks>-<tree 3 ranks>`.
 *
 * Each tree segment holds one digit per talent in the data's talent order (row, then column), with trailing
 * zeros trimmed. The layout hash is computed from the class, tree and talent ids and maximum ranks, so a link
 * made against a different version of the data is detected and refused instead of silently mapping points onto
 * different talents. Decoding validates everything and either returns a fully legal allocation or a reason.
 */

export type DecodeFailure = "format" | "layout" | "rank" | "illegal";
export type DecodeResult = { ok: true; allocation: Allocation } | { ok: false; reason: DecodeFailure };

export const BUILD_PARAM = "b";
const MAX_CODE_LENGTH = 160;
const SHAPE = /^([0-9a-z]{1,8})\.([0-9]*(?:-[0-9]*)*)$/;

/** FNV-1a (32 bit) over the layout, as base-36. Not a security feature: only detects mismatching data versions. */
export function layoutHash(data: TalentClassData, buildVersion: string = data.build.version): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  feed(`${data.classId}|${buildVersion}`);
  for (const t of data.trees) {
    feed(`|T${t.id}`);
    for (const x of t.talents) feed(`,${x.id}:${x.maxRank}`);
  }
  return h.toString(36);
}

export function encodeBuild(data: TalentClassData, alloc: Allocation): string {
  const segments = data.trees.map((t) => t.talents.map((x) => String(alloc[x.id] ?? 0)).join("").replace(/0+$/, ""));
  return `${layoutHash(data)}.${segments.join("-")}`;
}

export function decodeBuild(engine: TalentEngine, code: string | null | undefined): DecodeResult {
  if (!code || code.length > MAX_CODE_LENGTH) return { ok: false, reason: "format" };
  const m = SHAPE.exec(code);
  if (!m) return { ok: false, reason: "format" };
  const { data } = engine;
  const segments = m[2]!.split("-");
  if (segments.length !== data.trees.length) return { ok: false, reason: "format" };
  // A link made for an earlier build is accepted only when the dataset declares that build's layout identical to its own
  // (verified by the importer, see import-talent-catalog.mjs). Anything else is refused.
  const known = [layoutHash(data), ...(data.build.layoutCompatibleWith ?? []).map((v) => layoutHash(data, v))];
  if (!known.includes(m[1]!)) return { ok: false, reason: "layout" };

  const allocation: Record<number, number> = {};
  for (const [i, tree] of data.trees.entries()) {
    const digits = segments[i]!;
    if (digits.length > tree.talents.length) return { ok: false, reason: "rank" };
    for (const [j, ch] of [...digits].entries()) {
      const rank = Number(ch);
      if (rank === 0) continue;
      if (rank > tree.talents[j]!.maxRank) return { ok: false, reason: "rank" };
      allocation[tree.talents[j]!.id] = rank;
    }
  }
  return engine.isLegal(allocation) ? { ok: true, allocation } : { ok: false, reason: "illegal" };
}

export const DECODE_FAILURE_TEXT: Record<DecodeFailure, string> = {
  format: "This build link is not valid.",
  layout: "This build link was made for a different version of the talent data, so it cannot be restored.",
  rank: "This build link contains ranks that do not exist for this class.",
  illegal: "This build link breaks the talent rules (tier, prerequisite or point limit), so it was not applied.",
};
