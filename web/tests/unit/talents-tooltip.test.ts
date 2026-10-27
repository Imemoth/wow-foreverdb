import { describe, expect, it } from "vitest";
import { GAP_CODES, GAP_TEXT, plain, renderTemplate, tidy, tidySegments, type EffectFacts, type SpellFacts } from "@/lib/talents/tooltip";

const eff = (index: number, over: Partial<EffectFacts> = {}): EffectFacts => ({ index, basePoints: 0, dieSides: 0, periodMs: 0, chainTargets: 0, radiusYards: null, ...over });
const facts = (effects: EffectFacts[], durationMs: number | null = null): SpellFacts => ({ effects, durationMs });
const r = (t: string, f: SpellFacts, rank?: number) => renderTemplate(t, f, rank);

describe("renderTemplate: values the data holds", () => {
  it("resolves effect values with the game's number format (sign dropped, at most two decimals)", () => {
    expect(plain(r("Deals $s1 and $s2.", facts([eff(0, { basePoints: 5 }), eff(1, { basePoints: -2 })])))).toBe("Deals 5 and 2.");
    expect(r("x $s1", facts([eff(0, { basePoints: 5 })])).complete).toBe(true);
    expect(plain(r("${$s1/3} per tick", facts([eff(0, { basePoints: 10 })])))).toBe("3.33 per tick");
    expect(plain(r("${$s1*2}.1", facts([eff(0, { basePoints: 10 })])))).toBe("20.0");
  });

  it("resolves the period, total, duration (sec/min/hour), radius and chain targets", () => {
    const f = facts([eff(0, { basePoints: 8, periodMs: 2000, radiusYards: 10, chainTargets: 3 })], 12000);
    expect(plain(r("$t1 sec, $o1 total over $d, $a1 yds, $x1 targets", f))).toBe("2 sec, 48 total over 12 sec, 10 yds, 3 targets");
    expect(plain(r("$d", facts([], 90000)))).toBe("1.5 min");
    expect(plain(r("$d", facts([], 3600000)))).toBe("1 hour");
    expect(plain(r("$d", facts([], 7200000)))).toBe("2 hours");
    expect(plain(r("$/1000;s1 sec", facts([eff(0, { basePoints: 1500 })])))).toBe("1.5 sec");
  });

  it("chooses the plural form from the number that precedes it", () => {
    expect(plain(r("$s1 $lcharge:charges;", facts([eff(0, { basePoints: 1 })])))).toBe("1 charge");
    expect(plain(r("$s1 $lcharge:charges;", facts([eff(0, { basePoints: 3 })])))).toBe("3 charges");
  });

  it("uses curve values only when the extraction supplies them for that rank", () => {
    const f = facts([eff(0, { basePoints: 15, curve: true, rankValues: [2, 4, 6] })]);
    expect(plain(r("+$m1%", f, 2))).toBe("+4%");
    expect(plain(r("+$m1%", f, 3))).toBe("+6%");
    expect(r("+$m1%", f, 4).gaps[0]!.code).toBe("curve"); // no value for that rank
    expect(r("+$m1%", f).gaps[0]!.code).toBe("curve"); // no rank given
  });
});

describe("renderTemplate: nothing is guessed", () => {
  it("never fills a curve-driven effect from the spell row, even though the row holds a number", () => {
    const x = r("Deals $m1% more.", facts([eff(0, { basePoints: 15, curve: true })]));
    expect(x.complete).toBe(false);
    expect(x.segments).toEqual(["Deals ", { g: "$m1", c: "curve" }, "% more."]);
    expect(plain(x)).not.toContain("15");
  });

  it("keeps every unsupported construct as a coded gap and never lets a raw $ token through", () => {
    const cases: Array<[string, GapCodeLike]> = [
      ["$12345s1", "spell"],
      ["$/10;16959s1", "spell"],
      ["$@spelldesc12345", "spell"],
      ["$h", "proc"],
      ["$rap", "named"],
      ["$<mult>", "named"],
      ["$?a1234[yes][no]", "conditional"],
      ["$s3", "effect"],
      ["$d", "effect"],
      ["${$s1+$rap}", "expr"],
      ["$s1", "zero"],
      ["$s1", "dice"],
    ];
    const rows: Record<string, SpellFacts> = { zero: facts([eff(0)]), dice: facts([eff(0, { basePoints: 4, dieSides: 6 })]) };
    for (const [tpl, code] of cases) {
      const x = r(tpl, rows[code] ?? facts([eff(0, { basePoints: 3 })]));
      expect(x.complete, tpl).toBe(false);
      expect(x.gaps[0]!.code, tpl).toBe(code);
      expect(plain(x), tpl).not.toMatch(/\$/);
    }
  });

  it("a plural after a missing number is a gap, not a guess", () => {
    const x = r("$s9 $lcharge:charges;", facts([eff(0, { basePoints: 1 })]));
    expect(x.gaps.map((g) => g.code)).toEqual(["effect", "plural"]);
  });

  it("every gap code has a user-facing explanation", () => {
    for (const c of GAP_CODES) expect(GAP_TEXT[c].length).toBeGreaterThan(20);
  });
});

type GapCodeLike = (typeof GAP_CODES)[number];

describe("display normalisation (never applied before hashing)", () => {
  it("removes colour escapes in either case, converts |n and Windows line breaks", () => {
    expect(tidy("|cFFFFD100Gold|r and |CFFFFFFFFwhite|R text|nnext\r\nline")).toBe("Gold and white text\nnext\nline");
  });

  it("trims only the outer whitespace of a rendering and leaves gaps alone", () => {
    const out = tidySegments(["  a ", { g: "$s1", c: "curve" }, " b  "]);
    expect(out).toEqual(["a ", { g: "$s1", c: "curve" }, " b"]);
  });
});
