import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSES, getSpecs } from "@/lib/classes/classes";
import { decodeBuild, encodeBuild, layoutHash } from "@/lib/talents/build-code";
import { createEngine } from "@/lib/talents/engine";
import { availableTalentClasses, getTalentData, TALENT_BUILD, TALENT_MANIFEST } from "@/lib/talents/registry";
import { TalentClassSchema, validateTalentClass } from "@/lib/talents/schema";
import type { TalentClassData } from "@/lib/talents/types";

const DIR = join(process.cwd(), "src", "data", "talents", "forever", TALENT_BUILD.version);

describe("shipped talent data (WoW: Forever)", () => {
  it("covers exactly the nine classes of the Class Guides", () => {
    expect(availableTalentClasses().sort()).toEqual(CLASSES.map((c) => c.id).sort());
  });

  describe.each(CLASSES.map((c) => c.id))("%s", (id) => {
    const data = getTalentData(id) as TalentClassData;

    it("passes the schema and structural validation", () => {
      expect(TalentClassSchema.parse(data)).toBeTruthy();
      expect(validateTalentClass(data)).toEqual([]);
    });

    it("is stamped with the dataset build and has three trees", () => {
      expect(data.classId).toBe(id);
      expect(data.build).toEqual({ version: TALENT_BUILD.version, buildId: TALENT_BUILD.buildId, layoutCompatibleWith: ["1.60.1.70630"] });
      expect(data.trees).toHaveLength(3);
    });

    it("takes its point budget from the client's point levels (one point per level)", () => {
      const { total, firstPointLevel, lastPointLevel } = data.pointBudget;
      expect(total).toBe(51);
      expect(lastPointLevel - firstPointLevel + 1).toBe(total);
    });

    it("keeps the observed tier rule: no gate on row 0, otherwise 5 points per row above", () => {
      for (const t of data.trees) {
        for (const x of t.talents) {
          if (x.row === 0) expect(x.pointsRequired, `${t.name}/${x.name}`).toBeUndefined();
          else expect(x.pointsRequired, `${t.name}/${x.name}`).toBe(x.row * 5);
        }
      }
    });

    it("lets every talent be reached and maxed in some legal order (no dead or circular requirements)", () => {
      const roomy = createEngine({ ...data, pointBudget: { ...data.pointBudget, total: 10_000 } });
      let alloc = roomy.reset();
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (const t of data.trees) {
          for (const x of t.talents) {
            while (roomy.canAdd(alloc, x.id).ok) {
              alloc = roomy.add(alloc, x.id);
              progressed = true;
            }
          }
        }
      }
      for (const t of data.trees) for (const x of t.talents) expect(roomy.rank(alloc, x.id), `${t.name}/${x.name}`).toBe(x.maxRank);
    });

    it("offers more talent ranks than points, so the budget actually constrains builds", () => {
      const ranks = data.trees.flatMap((t) => t.talents).reduce((s, x) => s + x.maxRank, 0);
      expect(ranks).toBeGreaterThan(data.pointBudget.total);
    });

    it("round-trips a legal full-budget build through the share code", () => {
      const e = createEngine(data);
      let alloc = e.reset();
      // Fill the budget greedily, tree by tree, in data order.
      for (const t of data.trees) {
        for (const x of t.talents) while (e.canAdd(alloc, x.id).ok) alloc = e.add(alloc, x.id);
      }
      expect(e.remaining(alloc)).toBe(0);
      expect(decodeBuild(e, encodeBuild(data, alloc))).toEqual({ ok: true, allocation: alloc });
    });

    it("has unique spec URL slugs", () => {
      const slugs = getSpecs(id).map((s) => s.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });
  });

  it("matches the integrity hashes recorded in the manifest", () => {
    for (const id of availableTalentClasses()) {
      const sha = createHash("sha256").update(readFileSync(join(DIR, `${id}.json`))).digest("hex");
      expect(sha, id).toBe(TALENT_MANIFEST.output.sha256[id]);
    }
  });

  it("records where the data came from", () => {
    expect(TALENT_MANIFEST.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(TALENT_MANIFEST.source.repository).toMatch(/^https:\/\//);
    expect(TALENT_MANIFEST.build.version).toBe(TALENT_BUILD.version);
    expect(Object.keys(TALENT_MANIFEST.source.sha256).sort()).toEqual(CLASSES.map((c) => c.id).sort());
  });
});

// Layout hashes of the 1.60.1.70630 dataset, captured from that dataset before the move to 1.60.1.70634 (the hash covers the
// class, the build string, tree ids and every talent's id and max rank). Pinned as literals so a later change to the
// structure or to the hash cannot silently invalidate links that were shared for 70630.
const LEGACY_70630_HASH: Record<string, string> = {
  warrior: "1tb877i", paladin: "trhiq1", hunter: "1lmnj7k", rogue: "1t7bvh1", priest: "1k68lpi", shaman: "1scyk30", mage: "xqy51a", warlock: "mi4cb2", druid: "1xgbguo",
};

describe("share links made for build 1.60.1.70630", () => {
  it.each(CLASSES.map((c) => c.id))("%s: the dataset declares and reproduces the 70630 layout, and old links decode", (id) => {
    const data = getTalentData(id) as TalentClassData;
    expect(data.build.layoutCompatibleWith).toEqual(["1.60.1.70630"]);
    expect(layoutHash(data, "1.60.1.70630")).toBe(LEGACY_70630_HASH[id]);
    expect(layoutHash(data)).not.toBe(LEGACY_70630_HASH[id]); // new links carry the new build
    const engine = createEngine(data);
    // A real allocation: the first talent of every tree that has no requirements, one point each.
    const alloc: Record<number, number> = {};
    for (const t of data.trees) alloc[t.talents[0]!.id] = 1;
    const modern = encodeBuild(data, alloc);
    const legacy = `${LEGACY_70630_HASH[id]}.${modern.split(".")[1]}`;
    const a = decodeBuild(engine, legacy), b = decodeBuild(engine, modern);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it("a link from any other build is still refused", () => {
    const data = getTalentData("priest") as TalentClassData;
    const engine = createEngine(data);
    const modern = encodeBuild(data, { [data.trees[0]!.talents[0]!.id]: 1 });
    const tail = modern.split(".")[1];
    expect(decodeBuild(engine, `${layoutHash(data, "1.60.1.70532")}.${tail}`)).toEqual({ ok: false, reason: "layout" });
    expect(decodeBuild(engine, `${LEGACY_70630_HASH.mage}.${tail}`)).toEqual({ ok: false, reason: "layout" });
  });
});
