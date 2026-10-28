import type { Allocation, Talent, TalentClassData, TalentTree } from "./types";

/**
 * Pure talent rules. Nothing here knows about React, the DOM or URLs, and every function returns new data
 * instead of mutating its input, so the calculator can treat an Allocation as plain state.
 *
 * A talent may take a point when
 *   1. it is below its maximum rank,
 *   2. its prerequisites are met (each required talent at its full rank unless the data names a minimum;
 *      "any"-rule prerequisites need at least one of them),
 *   3. the points already spent in its own tree on the rows above it reach its tier gate,
 *   4. the shared budget (all trees together) has a point left.
 * A point may be removed only if the resulting allocation is still legal for every talent that has points,
 * which covers both "a later row depends on this point" and "a dependent talent needs this prerequisite".
 *
 * Rules 2 and 3 come from the client data (see TalentClassData); "full rank" for prerequisites is the
 * conventional reading and is flagged as inferred in the documentation and the UI.
 */

export type Refusal = "unknown" | "max-rank" | "prerequisite" | "tier" | "no-points" | "empty" | "dependents";
export type Verdict = { ok: true } | { ok: false; reason: Refusal };

export type Requirement =
  | { kind: "points"; needed: number; have: number; met: boolean; treeName: string; assumedScope: boolean }
  | { kind: "talent"; talentId: number; name: string; needed: number; have: number; met: boolean; anyOf: boolean };

const OK: Verdict = { ok: true };
const no = (reason: Refusal): Verdict => ({ ok: false, reason });

export interface TalentEngine {
  readonly data: TalentClassData;
  talent(id: number): Talent | undefined;
  treeOf(id: number): TalentTree | undefined;
  rank(alloc: Allocation, id: number): number;
  spent(alloc: Allocation): number;
  remaining(alloc: Allocation): number;
  pointsInTree(alloc: Allocation, treeId: number): number;
  /** Points spent in the tree on rows strictly above `row`. */
  pointsAbove(alloc: Allocation, treeId: number, row: number): number;
  requirements(alloc: Allocation, id: number): Requirement[];
  canAdd(alloc: Allocation, id: number): Verdict;
  canRemove(alloc: Allocation, id: number): Verdict;
  add(alloc: Allocation, id: number): Allocation;
  remove(alloc: Allocation, id: number): Allocation;
  reset(): Allocation;
  isLegal(alloc: Allocation): boolean;
}

export function createEngine(data: TalentClassData): TalentEngine {
  const talents = new Map<number, Talent>();
  const trees = new Map<number, TalentTree>();
  const treeOfTalent = new Map<number, TalentTree>();
  for (const t of data.trees) {
    trees.set(t.id, t);
    for (const x of t.talents) {
      talents.set(x.id, x);
      treeOfTalent.set(x.id, t);
    }
  }
  const budget = data.pointBudget.total;

  const rank = (alloc: Allocation, id: number) => alloc[id] ?? 0;
  const spent = (alloc: Allocation) => Object.values(alloc).reduce((s, r) => s + r, 0);

  function pointsAbove(alloc: Allocation, treeId: number, row: number): number {
    const tree = trees.get(treeId);
    if (!tree) return 0;
    let sum = 0;
    for (const x of tree.talents) if (x.row < row) sum += rank(alloc, x.id);
    return sum;
  }

  function requirements(alloc: Allocation, id: number): Requirement[] {
    const x = talents.get(id);
    const tree = treeOfTalent.get(id);
    if (!x || !tree) return [];
    const out: Requirement[] = [];
    if (x.pointsRequired !== undefined) {
      const have = pointsAbove(alloc, tree.id, x.row);
      out.push({ kind: "points", needed: x.pointsRequired, have, met: have >= x.pointsRequired, treeName: tree.name, assumedScope: x.pointsRequiredScope === "assumed-tree" });
    }
    for (const r of x.requires ?? []) {
      const target = talents.get(r.talentId);
      if (!target) continue;
      const needed = r.minRank ?? target.maxRank;
      const have = rank(alloc, target.id);
      out.push({ kind: "talent", talentId: target.id, name: target.name, needed, have, met: have >= needed, anyOf: r.rule === "any" });
    }
    return out;
  }

  function prerequisitesMet(alloc: Allocation, id: number): boolean {
    const talentReqs = requirements(alloc, id).filter((r): r is Extract<Requirement, { kind: "talent" }> => r.kind === "talent");
    const allOf = talentReqs.filter((r) => !r.anyOf);
    const anyOf = talentReqs.filter((r) => r.anyOf);
    return allOf.every((r) => r.met) && (anyOf.length === 0 || anyOf.some((r) => r.met));
  }

  function tierMet(alloc: Allocation, id: number): boolean {
    return requirements(alloc, id).every((r) => r.kind !== "points" || r.met);
  }

  /** Prerequisites and tier gate only: whether a point could be bought here, ignoring rank and budget. */
  const unlocked = (alloc: Allocation, id: number) => prerequisitesMet(alloc, id) && tierMet(alloc, id);

  /**
   * An allocation is legal when it fits the budget and can be built from nothing by legal single-point additions.
   * Checking each talent in isolation is not enough: the client data contains edges that point both ways, so two
   * talents can "satisfy" each other with no way in, and such a state could never be reached in the game.
   * Requirements only get easier as points are added, so greedily buying whatever is currently allowed finds a
   * valid order whenever one exists.
   */
  function isLegal(alloc: Allocation): boolean {
    const target: Array<[number, number]> = [];
    let total = 0;
    for (const [key, r] of Object.entries(alloc)) {
      const id = Number(key);
      const x = talents.get(id);
      if (!x || !Number.isInteger(r) || r < 0 || r > x.maxRank) return false;
      total += r;
      if (r > 0) target.push([id, r]);
    }
    if (total > budget) return false;
    let built: Allocation = {};
    for (let progressed = true; progressed; ) {
      progressed = false;
      for (const [id, want] of target) {
        while (rank(built, id) < want && unlocked(built, id)) {
          built = withRank(built, id, rank(built, id) + 1);
          progressed = true;
        }
      }
    }
    return target.every(([id, want]) => rank(built, id) === want);
  }

  function withRank(alloc: Allocation, id: number, next: number): Allocation {
    const copy = { ...alloc };
    if (next <= 0) delete copy[id];
    else copy[id] = next;
    return copy;
  }

  function canAdd(alloc: Allocation, id: number): Verdict {
    const x = talents.get(id);
    if (!x) return no("unknown");
    if (rank(alloc, id) >= x.maxRank) return no("max-rank");
    // What the talent itself needs is checked before the budget, so a locked talent always says why it is locked.
    if (!prerequisitesMet(alloc, id)) return no("prerequisite");
    if (!tierMet(alloc, id)) return no("tier");
    if (spent(alloc) >= budget) return no("no-points");
    return OK;
  }

  function canRemove(alloc: Allocation, id: number): Verdict {
    if (!talents.has(id)) return no("unknown");
    const r = rank(alloc, id);
    if (r <= 0) return no("empty");
    return isLegal(withRank(alloc, id, r - 1)) ? OK : no("dependents");
  }

  return {
    data,
    talent: (id) => talents.get(id),
    treeOf: (id) => treeOfTalent.get(id),
    rank,
    spent,
    remaining: (alloc) => budget - spent(alloc),
    pointsInTree: (alloc, treeId) => trees.get(treeId)?.talents.reduce((s, x) => s + rank(alloc, x.id), 0) ?? 0,
    pointsAbove,
    requirements,
    canAdd,
    canRemove,
    // Return the very same object when nothing changes so callers can tell a refused click from a real one.
    add: (alloc, id) => (canAdd(alloc, id).ok ? withRank(alloc, id, rank(alloc, id) + 1) : alloc),
    remove: (alloc, id) => (canRemove(alloc, id).ok ? withRank(alloc, id, rank(alloc, id) - 1) : alloc),
    reset: () => ({}),
    isLegal,
  };
}

export const REFUSAL_TEXT: Record<Refusal, string> = {
  unknown: "Unknown talent.",
  "max-rank": "Already at maximum rank.",
  prerequisite: "Requires a prerequisite talent first.",
  tier: "Spend more points in this tree to unlock this row.",
  "no-points": "No talent points remaining.",
  empty: "No points to remove.",
  dependents: "Another talent depends on this point.",
};
