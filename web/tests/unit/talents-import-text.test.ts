import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Runs the real importer on a small synthetic dataset: it must accept only what verifies and say exactly why for the rest.
const SCRIPT = join(process.cwd(), "scripts", "import-talent-text.mjs");
const root = mkdtempSync(join(tmpdir(), "azerdex-import-text-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const hash = (d: string) => createHash("sha256").update(d + "\0").digest("hex").slice(0, 12);
const BUILD = "9.9.9.2";
const OLD = "9.9.9.1";

interface Fx { name: string; tpl: string; storedHash?: string; eff?: object[]; prevEff?: object[]; curve?: boolean; ranks?: number }
const effect = (basePoints: number) => ({ index: 0, basePoints, dieSides: 0, periodMs: 0, chainTargets: 0, miscValue: 0, radiusYards: null });

function setup(name: string, talents: Fx[], opts: { sameBuild?: boolean } = {}) {
  const dir = join(root, name);
  const dataset = join(dir, "dataset"), templates = join(dir, "templates");
  mkdirSync(dataset, { recursive: true });
  mkdirSync(templates, { recursive: true });
  const spells: Record<string, unknown> = {}, prev: Record<string, unknown> = {};
  const nodes = talents.map((t, i) => {
    const spellId = 1000 + i;
    spells[spellId] = { name: t.name, durationMs: null, textHash: t.storedHash ?? hash(t.tpl), effects: t.eff ?? [effect(5)] };
    prev[spellId] = { name: t.name, durationMs: null, textHash: hash(t.tpl), effects: t.prevEff ?? t.eff ?? [effect(5)] };
    return { id: 500 + i, entries: [{ id: 700 + i, spellId, descriptionTemplate: t.tpl, effects: [{ index: 0, perRankStatus: t.curve ? "resolved" : "none", perRank: [{ rank: 1, value: 2 }, { rank: 2, value: 4 }] }] }] };
  });
  writeFileSync(join(dataset, "manifest.json"), JSON.stringify({ build: { version: BUILD }, output: { sha256: { testclass: "x" } } }));
  writeFileSync(
    join(dataset, "testclass.json"),
    JSON.stringify({ trees: [{ name: "T", talents: talents.map((t, i) => ({ id: 500 + i, name: t.name, spellId: 1000 + i, row: 0, col: i, maxRank: t.ranks ?? 2 })) }] }),
  );
  writeFileSync(join(templates, "testclass.json"), JSON.stringify({ trees: [{ nodes }] }));
  const sv = (version: string, spellsOf: object) => ({ build: { version, extractedAt: "2026-01-01T00:00:00.000Z" }, spells: spellsOf });
  writeFileSync(join(dir, "sv.json"), JSON.stringify(sv(BUILD, spells)));
  writeFileSync(join(dir, "sv-prev.json"), JSON.stringify(sv(OLD, prev)));
  const args = [SCRIPT, "--dataset", dataset, "--templates", templates, "--templates-build", opts.sameBuild ? BUILD : OLD, "--templates-ref", "test@1", "--spell-values", join(dir, "sv.json"), "--spell-values-ref", "test@2", "--spell-values-prev", join(dir, "sv-prev.json"), "--allow-any-count"];
  return { dataset, args, text: () => JSON.parse(readFileSync(join(dataset, "text.json"), "utf8")), coverage: () => JSON.parse(readFileSync(join(dataset, "coverage.json"), "utf8")) };
}

describe("import-talent-text.mjs", () => {
  it("accepts only verified text and records the exact reason for everything else", () => {
    const fx = setup("mixed", [
      { name: "Plain", tpl: "Deals $s1 damage." },
      { name: "Curved", tpl: "Deals $m1% more." , curve: true },
      { name: "Changed", tpl: "Old wording $s1.", storedHash: "ffffffffffff" },
      { name: "Drifted", tpl: "Heals $s1.", eff: [effect(7)], prevEff: [effect(5)] },
    ]);
    execFileSync("node", fx.args, { stdio: "pipe" });
    const text = fx.text(), cov = fx.coverage();
    expect(text.schema).toBe("azerdex.talent-text/2");
    expect(text.build).toBe(BUILD);
    expect(text.source.extractedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(Object.keys(text.talents)).toEqual(["500", "501"]);
    expect(text.talents["500"].segments).toEqual(["Deals 5 damage."]);
    expect(text.talents["500"].complete).toBe(true);
    // Templates from another build: per-rank values are never taken from them, so the curve effect stays a gap.
    expect(text.talents["501"].segments).toEqual(["Deals ", { g: "$m1", c: "curve" }, "% more."]);
    const by = Object.fromEntries(cov.talents.map((t: { name: string }) => [t.name, t]));
    expect(by.Plain).toMatchObject({ status: "complete", ranksVerified: 2 });
    expect(by.Curved).toMatchObject({ status: "partial", gaps: ["curve"], ranksVerified: 0 });
    expect(by.Changed.status).toBe("unverified");
    expect(by.Changed.reason).toMatch(/text hash/);
    expect(by.Drifted.status).toBe("unverified");
    expect(by.Drifted.reason).toMatch(/differ between/);
    expect(cov.summary).toMatchObject({ nodes: 4, withVerifiedText: 2, everyRankFullyResolved: 1, withValidIcon: 0 });
  });

  it("uses per-rank curve values only when the templates come from the target build itself", () => {
    const fx = setup("same-build", [{ name: "Curved", tpl: "Deals $m1% more.", curve: true }], { sameBuild: true });
    execFileSync("node", fx.args, { stdio: "pipe" });
    const e = fx.text().talents["500"];
    expect(e.ranks.map((r: { segments: string[] }) => r.segments)).toEqual([["Deals 2% more."], ["Deals 4% more."]]);
    expect(e.complete).toBe(true);
    expect(fx.coverage().summary.ranksFullyResolved).toBe(2);
  });

  it("is deterministic and reports no change on a second run", () => {
    const fx = setup("repeat", [{ name: "Plain", tpl: "Deals $s1 damage." }]);
    execFileSync("node", fx.args, { stdio: "pipe" });
    const first = readFileSync(join(fx.dataset, "text.json"), "utf8");
    const out = execFileSync("node", fx.args, { stdio: "pipe" }).toString();
    expect(readFileSync(join(fx.dataset, "text.json"), "utf8")).toBe(first);
    expect(out).toMatch(/"changed": 0/);
  });

  it("--check validates without writing", () => {
    const fx = setup("check", [{ name: "Plain", tpl: "Deals $s1 damage." }]);
    execFileSync("node", [...fx.args, "--check"], { stdio: "pipe" });
    expect(existsSync(join(fx.dataset, "text.json"))).toBe(false);
  });

  it("refuses spell values of another build and leaves existing files untouched", () => {
    const fx = setup("wrong-build", [{ name: "Plain", tpl: "Deals $s1 damage." }]);
    const sv = JSON.parse(readFileSync(join(root, "wrong-build", "sv.json"), "utf8"));
    sv.build.version = "1.0.0.1";
    writeFileSync(join(root, "wrong-build", "sv.json"), JSON.stringify(sv));
    writeFileSync(join(fx.dataset, "text.json"), "KEEP");
    const res = spawnSync("node", fx.args, { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(readFileSync(join(fx.dataset, "text.json"), "utf8")).toBe("KEEP");
  });

  it("does not run with the full count requirement unless the dataset really has 466 talents", () => {
    const fx = setup("count", [{ name: "Plain", tpl: "Deals $s1 damage." }]);
    const res = spawnSync("node", fx.args.filter((a) => a !== "--allow-any-count"), { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/expected 466 talents/);
    expect(existsSync(join(fx.dataset, "text.json"))).toBe(false);
  });
});

describe("import-talent-text.mjs with a local-client snapshot", () => {
  interface Snap { name: string; desc: string; aura?: string; defs: number[]; catalogDef: number; curves?: Array<{ definitionId: number; effectIndex: number; rankValues: Array<number | null>; allRanksPresent?: boolean }>; effects?: object[]; hashOverride?: string; maxRank?: number }

  function setupSnapshot(name: string, talents: Snap[], snapBuild = BUILD) {
    const dir = join(root, name);
    const dataset = join(dir, "dataset"), catalog = join(dir, "catalog");
    mkdirSync(dataset, { recursive: true });
    mkdirSync(catalog, { recursive: true });
    const spells: Record<string, unknown> = {};
    const snap = talents.map((t, i) => {
      const spellId = 2000 + i;
      const aura = t.aura ?? "";
      spells[spellId] = { name: t.name, durationMs: null, textHash: t.hashOverride ?? createHash("sha256").update(t.desc + "\0" + aura).digest("hex").slice(0, 12), effects: t.effects ?? [effect(5)] };
      return { nodeId: 900 + i, spellId, maxRank: t.maxRank ?? 3, name: t.name, description: t.desc, auraDescription: aura, definitionIds: t.defs, curves: (t.curves ?? []).map((c) => ({ allRanksPresent: true, ...c })), iconFileDataId: 1, sourceGameBuild: `${snapBuild} (test)` };
    });
    writeFileSync(join(dataset, "manifest.json"), JSON.stringify({ build: { version: BUILD }, output: { sha256: { testclass: "x" } } }));
    writeFileSync(join(dataset, "testclass.json"), JSON.stringify({ trees: [{ name: "T", talents: talents.map((t, i) => ({ id: 900 + i, name: t.name, spellId: 2000 + i, row: 0, col: i, maxRank: t.maxRank ?? 3 })) }] }));
    writeFileSync(join(catalog, "testclass.json"), JSON.stringify({ build: { version: BUILD }, trees: [{ nodes: talents.map((t, i) => ({ id: 900 + i, entries: [{ spellId: 2000 + i, definitionId: t.catalogDef }] })) }] }));
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ schema: "azerdex.local-client-talent-snapshot/2", source: { archiveSha256: "a".repeat(64) }, talents: snap }));
    writeFileSync(join(dir, "sv.json"), JSON.stringify({ build: { version: BUILD, extractedAt: "2026-01-01T00:00:00.000Z" }, spells }));
    const args = [SCRIPT, "--dataset", dataset, "--client-snapshot", join(dir, "snapshot.json"), "--catalog", catalog, "--templates-build", BUILD, "--templates-ref", "test snapshot", "--spell-values", join(dir, "sv.json"), "--spell-values-ref", "test@2", "--allow-any-count"];
    return { dataset, args, text: () => JSON.parse(readFileSync(join(dataset, "text.json"), "utf8")), coverage: () => JSON.parse(readFileSync(join(dataset, "coverage.json"), "utf8")) };
  }

  it("hashes description AND aura text, takes the definition from the catalog and fills every rank from that definition's curve", () => {
    const fx = setupSnapshot("snap-main", [
      { name: "WithAura", desc: "Deals $s1 damage.", aura: "Aura text.", defs: [10], catalogDef: 10 },
      // The snapshot's own heuristic would pick definition 20; the catalog says 21, so only 21's curve is used.
      { name: "TwoDefinitions", desc: "Gain $m1%.", defs: [20, 21], catalogDef: 21, curves: [{ definitionId: 20, effectIndex: 0, rankValues: [100, 200, 300] }, { definitionId: 21, effectIndex: 0, rankValues: [2, 4, 6] }] },
      // Ranks 3 is missing in the extraction: it stays a gap, ranks 1-2 resolve.
      { name: "Partial", desc: "Gain $m1%.", defs: [30], catalogDef: 30, curves: [{ definitionId: 30, effectIndex: 0, rankValues: [3, 6, null], allRanksPresent: false }] },
      // The value lives only in the curve (the spell row has no such effect).
      { name: "CurveOnly", desc: "Gain $m2%.", defs: [40], catalogDef: 40, maxRank: 2, curves: [{ definitionId: 40, effectIndex: 1, rankValues: [7, 9] }] },
    ]);
    execFileSync("node", fx.args, { stdio: "pipe" });
    const t = fx.text();
    expect(t.build).toBe(BUILD);
    expect(t.source.templates).toMatchObject({ kind: "local-client-snapshot", definitionsFrom: `catalog of build ${BUILD}`, archiveSha256: "a".repeat(64) });
    expect(t.talents["900"].segments).toEqual(["Deals 5 damage."]);
    expect(t.talents["901"].ranks.map((r: { segments: string[] }) => r.segments.join(""))).toEqual(["Gain 2%.", "Gain 4%.", "Gain 6%."]);
    const partial = t.talents["902"].ranks;
    expect(partial.map((r: { complete: boolean }) => r.complete)).toEqual([true, true, false]);
    expect(partial[2].segments).toEqual(["Gain ", { g: "$m1", c: "curve" }, "%."]);
    expect(t.talents["903"].ranks.map((r: { segments: string[] }) => r.segments.join(""))).toEqual(["Gain 7%.", "Gain 9%."]);
    const cov = fx.coverage();
    expect(cov.summary).toMatchObject({ nodes: 4, withVerifiedText: 4, everyRankFullyResolved: 3, ranksTotal: 11, ranksFullyResolved: 10 });
  });

  it("rejects a description whose hash does not match, and a catalog definition missing from the snapshot", () => {
    const fx = setupSnapshot("snap-bad", [
      { name: "WrongHash", desc: "Deals $s1.", defs: [10], catalogDef: 10, hashOverride: "000000000000" },
      { name: "NoDefinition", desc: "Deals $s1.", defs: [11], catalogDef: 99 },
      { name: "Fine", desc: "Deals $s1.", defs: [12], catalogDef: 12 },
    ]);
    execFileSync("node", fx.args, { stdio: "pipe" });
    const by = Object.fromEntries(fx.coverage().talents.map((x: { name: string }) => [x.name, x]));
    expect(by.WrongHash.status).toBe("unverified");
    expect(by.NoDefinition.status).toBe("unverified");
    expect(by.NoDefinition.reason).toMatch(/trait definition 99/);
    expect(by.Fine.status).toBe("complete");
    expect(Object.keys(fx.text().talents)).toEqual(["902"]);
  });

  it("refuses a snapshot that is not from the build it is declared for", () => {
    const fx = setupSnapshot("snap-other-build", [{ name: "A", desc: "x $s1", defs: [1], catalogDef: 1 }], "9.9.9.9");
    const res = spawnSync("node", fx.args, { encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(existsSync(join(fx.dataset, "text.json"))).toBe(false);
  });
});
