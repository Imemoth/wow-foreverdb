import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plain, renderTemplate, type SpellFacts } from "@/lib/talents/tooltip";

const dir = join(process.cwd(), "src/data/talents/forever/1.60.1.70634");
const data = JSON.parse(readFileSync(join(dir, "text.json"), "utf8"));
const coverage = JSON.parse(readFileSync(join(dir, "coverage.json"), "utf8"));
const cases = [
  { id: 105832, spell: 15326, ranks: 5, refs: ["$15269d"] },
  { id: 105833, spell: 15270, ranks: 5, refs: ["$15271s1", "$15271d", "$15271S2"] },
  { id: 105823, spell: 1326159, ranks: 5, refs: ["$1326168d"] },
  { id: 105821, spell: 15257, ranks: 3, refs: ["$15258s1", "$15258d", "$15258u"] },
  { id: 105824, spell: 15487, ranks: 1, refs: ["$1241057d"] },
] as const;

describe("Priest Shadow, build 1.60.1.70634: 19 rank regression", () => {
  for (const t of cases) for (let rank = 1; rank <= t.ranks; rank++) {
    it(`${t.id} spell ${t.spell} rank ${rank}: preserves exact unresolved tokens`, () => {
      expect(data.build).toBe("1.60.1.70634");
      const row = data.talents[String(t.id)];
      expect(row.spellId).toBe(t.spell);
      const entry = row.ranks ? row.ranks[rank - 1] : row;
      const gaps = entry.segments.filter((s: unknown) => typeof s !== "string").map((s: { g: string; c: string }) => s.g);
      expect(gaps.sort()).toEqual([...t.refs].sort());
      expect(entry.complete).toBe(false);
      expect(entry.segments.filter((s: unknown) => typeof s !== "string").every((s: { c: string }) => s.c === "spell")).toBe(true);
      expect(coverage.talents.find((x: { id: number }) => x.id === t.id)?.ranksVerified).toBe(0);
    });
  }
});

const empty: SpellFacts = { effects: [], durationMs: null };
const effect = (index: number, basePoints: number) => ({ index, basePoints, dieSides: 0, periodMs: 0, chainTargets: 0, radiusYards: null });

describe("cross-spell resolution is explicit, conservative and independent of talent ranks", () => {
  it("does not silently resolve a reference from the talent's own spell", () => {
    const f: SpellFacts = { effects: [effect(0, 99)], durationMs: 999000 };
    expect(renderTemplate("$15269d $15271s1", f, 1).gaps.map((g) => g.code)).toEqual(["spell", "spell"]);
  });
  it("resolves a verified external duration and effects without modifying the other token", () => {
    const links = { "15269": { effects: [], durationMs: 3000 }, "15271": { effects: [effect(0, 25)], durationMs: null } };
    const x = renderTemplate("Stun $15269d, increase $15271s1%, stacks $15258u.", empty, 1, links);
    expect(plain(x)).toBe("Stun 3 sec, increase 25%, stacks [?].");
    expect(x.gaps.map((g) => g.code)).toEqual(["spell"]);
  });
  it("never uses missing or zero effects, dice, or absent durations", () => {
    const links = { "15269": { effects: [effect(0, 0)], durationMs: null }, "15271": { effects: [{ ...effect(0, 4), dieSides: 2 }], durationMs: null } };
    const x = renderTemplate("$15269d $15269s1 $15271s1", empty, 1, links);
    expect(x.gaps.map((g) => g.code)).toEqual(["spell", "spell", "spell"]);
  });
});
