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
