import { describe, expect, it } from "vitest";
import { createEngine } from "@/lib/talents/engine";
import type { Allocation } from "@/lib/talents/types";
import { SYNTHETIC } from "./talents-fixture";

const e = createEngine(SYNTHETIC);

/** Applies add() n times, failing the test if any step is refused. */
function give(alloc: Allocation, id: number, n = 1): Allocation {
  let a = alloc;
  for (let i = 0; i < n; i++) {
    const v = e.canAdd(a, id);
    expect(v, `adding ${id} (#${i + 1})`).toEqual({ ok: true });
    a = e.add(a, id);
  }
  return a;
}

describe("allocation and maximum rank", () => {
  it("adds a point to a first-row talent and counts it", () => {
    const a = e.add({}, 11);
    expect(a).toEqual({ 11: 1 });
    expect(e.spent(a)).toBe(1);
    expect(e.remaining(a)).toBe(11);
    expect(e.pointsInTree(a, 1)).toBe(1);
  });

  it("never exceeds a talent's maximum rank", () => {
    const a = give({}, 12, 2);
    expect(e.canAdd(a, 12)).toEqual({ ok: false, reason: "max-rank" });
    expect(e.add(a, 12)).toBe(a);
  });

  it("refuses unknown talents", () => {
    expect(e.canAdd({}, 999)).toEqual({ ok: false, reason: "unknown" });
    expect(e.add({}, 999)).toEqual({});
  });
});

describe("tier gates", () => {
  it("locks a row until enough points sit on the rows above, in the same tree", () => {
    expect(e.canAdd({}, 13)).toEqual({ ok: false, reason: "tier" });
    const two = give({}, 11, 2);
    expect(e.canAdd(two, 13)).toEqual({ ok: false, reason: "tier" });
    const three = give({}, 11, 3);
    expect(e.canAdd(three, 13)).toEqual({ ok: true });
  });

  it("does not count points from another tree", () => {
    const other = give({}, 21, 5);
    expect(e.canAdd(other, 13)).toEqual({ ok: false, reason: "tier" });
    expect(e.canAdd(other, 22)).toEqual({ ok: true });
  });

  it("does not count points on the same row", () => {
    // A3 needs 3 points on rows above row 1; points already in A3/A4 (row 1) must not unlock A3/A4 themselves.
    const a = give(give({}, 11, 3), 13, 2);
    expect(e.pointsAbove(a, 1, 1)).toBe(3);
    expect(e.pointsAbove(a, 1, 2)).toBe(5);
  });

  it("reports gate progress and flags an assumed scope", () => {
    const reqs = e.requirements(give({}, 11, 2), 16);
    const points = reqs.find((r) => r.kind === "points");
    expect(points).toMatchObject({ kind: "points", needed: 5, have: 2, met: false, assumedScope: true });
  });
});

describe("prerequisites", () => {
  it("requires the prerequisite at full rank, not just one point", () => {
    const base = give({}, 11, 3);
    const half = give(base, 12, 1);
    expect(e.canAdd(half, 14)).toEqual({ ok: false, reason: "prerequisite" });
    const full = give(base, 12, 2);
    expect(e.canAdd(full, 14)).toEqual({ ok: true });
  });

  it('accepts any one of the "any" prerequisites', () => {
    // 5 points above row 2 first: A1 x3 + A2 x2.
    const base = give(give({}, 11, 3), 12, 2);
    expect(e.canAdd(base, 15)).toEqual({ ok: false, reason: "prerequisite" });
    const viaA3 = give(base, 13, 2);
    expect(e.canAdd(viaA3, 15)).toEqual({ ok: true });
    const viaA4 = give(base, 14, 1);
    expect(e.canAdd(viaA4, 15)).toEqual({ ok: true });
  });

  it("honours an explicit minimum rank", () => {
    const one = give({}, 11, 1);
    // pad to 5 points above row 2 using A2 so only the minRank rule is under test
    const base = give(give(give({}, 11, 3), 12, 2), 14, 1);
    expect(e.canAdd(base, 16)).toEqual({ ok: true });
    const lowRank = e.requirements(one, 16).find((r) => r.kind === "talent");
    expect(lowRank).toMatchObject({ kind: "talent", needed: 2, have: 1, met: false });
  });

  it("reports a prerequisite before a gate so a locked talent says why", () => {
    expect(e.canAdd({}, 14)).toEqual({ ok: false, reason: "prerequisite" });
  });
});

describe("shared point budget", () => {
  it("is shared across all trees", () => {
    let a: Allocation = give({}, 11, 3);
    a = give(a, 12, 2);
    a = give(a, 21, 5); // 10 spent
    expect(e.remaining(a)).toBe(2);
    a = give(a, 13, 2);
    expect(e.remaining(a)).toBe(0);
    expect(e.canAdd(a, 22)).toEqual({ ok: false, reason: "no-points" });
    expect(e.canAdd(a, 14)).toEqual({ ok: false, reason: "no-points" });
  });
});

describe("removal", () => {
  it("removes a point and refunds it", () => {
    const a = give({}, 11, 2);
    const b = e.remove(a, 11);
    expect(b).toEqual({ 11: 1 });
    expect(e.remove(b, 11)).toEqual({});
  });

  it("cannot remove a point that has none", () => {
    expect(e.canRemove({}, 11)).toEqual({ ok: false, reason: "empty" });
    expect(e.remove({}, 11)).toEqual({});
  });

  it("cannot remove a point that a later row's gate depends on", () => {
    const a = give(give({}, 11, 3), 13, 1);
    expect(e.canRemove(a, 11)).toEqual({ ok: false, reason: "dependents" });
    // removing the dependent first makes it legal
    expect(e.canRemove(e.remove(a, 13), 11)).toEqual({ ok: true });
  });

  it("cannot remove a prerequisite while its dependent has points", () => {
    const a = give(give(give({}, 11, 3), 12, 2), 14, 1);
    expect(e.canRemove(a, 12)).toEqual({ ok: false, reason: "dependents" });
  });

  it("can remove a point from a talent with surplus points above the gate", () => {
    const a = give(give(give({}, 11, 3), 12, 2), 13, 1); // 5 above row 1, gate needs 3
    expect(e.canRemove(a, 12)).toEqual({ ok: true });
  });
});

describe("mutually dependent talents (edges that point both ways in the client data)", () => {
  const base = give({}, 21, 5); // opens B2's gate

  it("can only be opened through the talent that is not part of the loop", () => {
    expect(e.canAdd(base, 23)).toEqual({ ok: false, reason: "prerequisite" });
    expect(e.canAdd(base, 24)).toEqual({ ok: false, reason: "prerequisite" });
    const withB2 = give(base, 22);
    expect(e.canAdd(withB2, 23)).toEqual({ ok: true });
    const all = give(give(withB2, 23), 24);
    expect(all).toMatchObject({ 22: 1, 23: 1, 24: 1 });
  });

  it("treats a loop with no way in as illegal, so a crafted allocation cannot skip the entry talent", () => {
    expect(e.isLegal({ 21: 5, 23: 1, 24: 1 })).toBe(false);
    expect(e.isLegal({ 21: 5, 22: 1, 23: 1, 24: 1 })).toBe(true);
  });

  it("cannot remove the entry talent while the loop depends on it", () => {
    const all = give(give(give(base, 22), 23), 24);
    expect(e.canRemove(all, 22)).toEqual({ ok: false, reason: "dependents" });
    expect(e.canRemove(all, 24)).toEqual({ ok: true });
  });
});

describe("reset and legality", () => {
  it("reset empties the allocation", () => {
    expect(e.reset()).toEqual({});
  });

  it("isLegal rejects gate, prerequisite, rank and budget violations", () => {
    expect(e.isLegal({})).toBe(true);
    expect(e.isLegal({ 13: 1 })).toBe(false); // no gate points
    expect(e.isLegal({ 11: 3, 14: 1 })).toBe(false); // A2 prerequisite missing
    expect(e.isLegal({ 12: 3 })).toBe(false); // above max rank
    expect(e.isLegal({ 11: 3, 12: 2, 21: 5, 13: 2, 22: 1 })).toBe(false); // 13 points > budget 12
    expect(e.isLegal({ 11: 1.5 })).toBe(false); // fractional rank
    expect(e.isLegal({ 777: 1 })).toBe(false); // unknown talent
  });

  it("per-tree and per-row counters add up", () => {
    const a = give(give({}, 11, 3), 21, 4);
    expect(e.pointsInTree(a, 1)).toBe(3);
    expect(e.pointsInTree(a, 2)).toBe(4);
    expect(e.spent(a)).toBe(7);
  });
});
