import { describe, expect, it } from "vitest";
import { decodeBuild, encodeBuild, layoutHash } from "@/lib/talents/build-code";
import { createEngine } from "@/lib/talents/engine";
import type { TalentClassData } from "@/lib/talents/types";
import { SYNTHETIC } from "./talents-fixture";

const e = createEngine(SYNTHETIC);
const GOOD = { 11: 3, 12: 2, 13: 2, 21: 4 };

describe("build code round trip", () => {
  it("encodes an empty build and restores it", () => {
    const code = encodeBuild(SYNTHETIC, {});
    expect(code).toMatch(/^[0-9a-z]+\.-$/);
    expect(decodeBuild(e, code)).toEqual({ ok: true, allocation: {} });
  });

  it("restores exactly the allocation that was encoded", () => {
    const code = encodeBuild(SYNTHETIC, GOOD);
    const r = decodeBuild(e, code);
    expect(r).toEqual({ ok: true, allocation: GOOD });
  });

  it("is stable and compact (trailing zero ranks are trimmed)", () => {
    expect(encodeBuild(SYNTHETIC, GOOD)).toBe(encodeBuild(SYNTHETIC, { ...GOOD }));
    expect(encodeBuild(SYNTHETIC, GOOD).split(".")[1]).toBe("322-4");
  });
});

describe("invalid build codes are rejected, never half-applied", () => {
  const hash = layoutHash(SYNTHETIC);
  const cases: Array<[string, string, string]> = [
    ["empty string", "", "format"],
    ["no separator", "abc", "format"],
    ["upper case / symbols", "ABC.1-2", "format"],
    ["script injection", "<script>.1-2", "format"],
    ["non-digit ranks", `${hash}.1x-2`, "format"],
    ["wrong number of trees", `${hash}.1`, "format"],
    ["too many trees", `${hash}.1-2-3`, "format"],
    ["absurdly long", `${hash}.${"1".repeat(500)}-`, "format"],
    ["layout hash of another data version", "zzzzzz.3-4", "layout"],
    ["more ranks than talents in a tree", `${hash}.1111111-`, "rank"],
    ["rank above the talent maximum", `${hash}.4-`, "rank"],
    ["row gate not met", `${hash}.001-`, "illegal"],
    ["prerequisite missing", `${hash}.3001-`, "illegal"],
    ["more points than the budget", `${hash}.3221-5`, "illegal"],
  ];
  for (const [name, code, reason] of cases) {
    it(`${name} -> ${reason}`, () => {
      expect(decodeBuild(e, code)).toEqual({ ok: false, reason });
    });
  }

  it("a code made for different layout data does not decode", () => {
    const moved: TalentClassData = JSON.parse(JSON.stringify(SYNTHETIC));
    moved.trees[0]!.talents[0]!.maxRank = 4;
    expect(layoutHash(moved)).not.toBe(layoutHash(SYNTHETIC));
    expect(decodeBuild(createEngine(moved), encodeBuild(SYNTHETIC, GOOD))).toEqual({ ok: false, reason: "layout" });
  });

  it("decoding null / undefined (no ?b parameter) is a format failure the caller can ignore", () => {
    expect(decodeBuild(e, null)).toEqual({ ok: false, reason: "format" });
    expect(decodeBuild(e, undefined)).toEqual({ ok: false, reason: "format" });
  });
});
