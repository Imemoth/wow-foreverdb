import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

// The real icon importer on synthetic talents and synthetic (non-Blizzard) 64x64 images.
const ICONS = join(process.cwd(), "scripts", "import-talent-icons.mjs");
const CATALOG = join(process.cwd(), "scripts", "import-talent-catalog.mjs");
const root = mkdtempSync(join(tmpdir(), "azerdex-import-icons-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const BUILD = "9.9.9.2";

async function setup(name: string, over: { mappingBuild?: string; snapshotIcon?: number; size?: number; corruptInventory?: boolean } = {}) {
  const dir = join(root, name);
  const dataset = join(dir, "dataset"), images = join(dir, "images", "talent-icons", BUILD);
  mkdirSync(dataset, { recursive: true });
  mkdirSync(images, { recursive: true });
  writeFileSync(join(dataset, "manifest.json"), JSON.stringify({ build: { version: BUILD }, output: { sha256: { testclass: "x" } } }));
  const talents = [1, 2, 3].map((n) => ({ id: 500 + n, name: `T${n}`, spellId: 3000 + n, row: 0, col: n, maxRank: 1 }));
  writeFileSync(join(dataset, "testclass.json"), JSON.stringify({ trees: [{ name: "T", talents }] }));
  // Talents 1 and 2 share one icon: 3 talents, 2 distinct images.
  const fileOf = (n: number) => (n === 3 ? 222 : 111);
  const rows = ["fileDataID,width,height,alpha,blp_bytes,webp_bytes,blp_sha256,webp_sha256"];
  for (const id of [111, 222]) {
    const buf = await sharp({ create: { width: over.size ?? 64, height: over.size ?? 64, channels: 3, background: { r: id % 255, g: 40, b: 90 } } }).webp({ lossless: true }).toBuffer();
    writeFileSync(join(images, `${id}.webp`), buf);
    rows.push(`${id},64,64,False,100,${buf.length},${"b".repeat(64)},${over.corruptInventory ? "0".repeat(64) : sha(buf)}`);
  }
  writeFileSync(join(dir, "inventory.csv"), rows.join("\n") + "\n");
  writeFileSync(join(dir, "mapping.json"), JSON.stringify({ build: over.mappingBuild ?? BUILD, icons: { 3001: fileOf(1), 3002: fileOf(2), 3003: fileOf(3) } }));
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ schema: "s", talents: talents.map((t, i) => ({ nodeId: t.id, spellId: t.spellId, iconFileDataId: i === 0 && over.snapshotIcon ? over.snapshotIcon : fileOf(i + 1), sourceGameBuild: BUILD })) }));
  const args = [ICONS, "--dataset", dataset, "--mapping", join(dir, "mapping.json"), "--snapshot", join(dir, "snapshot.json"), "--images", join(dir, "images"), "--inventory", join(dir, "inventory.csv"), "--allow-any-count"];
  return { dataset, args };
}

describe("import-talent-icons.mjs", () => {
  it("validates mapping, client ids, images and hashes, and writes ids and hashes only", async () => {
    const fx = await setup("ok");
    execFileSync("node", fx.args, { stdio: "pipe" });
    const icons = JSON.parse(readFileSync(join(fx.dataset, "icons.json"), "utf8"));
    expect(icons).toEqual({ schema: "azerdex.talent-icons/1", build: BUILD, icons: { 3001: 111, 3002: 111, 3003: 222 } });
    const inv = JSON.parse(readFileSync(join(fx.dataset, "icons-inventory.json"), "utf8"));
    expect(inv).toMatchObject({ build: BUILD, talents: 3, uniqueImages: 2 });
    expect(Object.keys(inv.files)).toEqual(["111", "222"]);
    expect(inv.files["111"]).toMatchObject({ width: 64, height: 64 });
    expect(JSON.stringify(inv)).not.toMatch(/base64|data:image/);
  });

  it("never relabels a manifest of another build", async () => {
    const fx = await setup("wrong-build", { mappingBuild: "9.9.9.1" });
    const res = spawnSync("node", fx.args, { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/refusing to relabel/);
    expect(existsSync(join(fx.dataset, "icons.json"))).toBe(false);
  });

  it("refuses a mapping that disagrees with the client's own icon id for a talent", async () => {
    const fx = await setup("disagree", { snapshotIcon: 999 });
    const res = spawnSync("node", fx.args, { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/!= client SpellMisc 999/);
  });

  it("refuses images of the wrong size or whose hash differs from the inventory", async () => {
    const small = spawnSync("node", (await setup("small", { size: 32 })).args, { encoding: "utf8" });
    expect(small.status).toBe(1);
    expect(small.stderr).toMatch(/not a 64x64 WebP/);
    const hash = spawnSync("node", (await setup("hash", { corruptInventory: true })).args, { encoding: "utf8" });
    expect(hash.status).toBe(1);
    expect(hash.stderr).toMatch(/sha256 differs/);
  });

  it("--check validates without writing", async () => {
    const fx = await setup("check");
    execFileSync("node", [...fx.args, "--check"], { stdio: "pipe" });
    expect(existsSync(join(fx.dataset, "icons.json"))).toBe(false);
  });
});

describe("import-talent-catalog.mjs --layout-compatible", () => {
  const node = (id: number, maxRanks: number) => ({ id, row: 0, col: id - 1, kind: "single", maxRanks, entries: [{ definitionId: id, spellId: 100 + id, name: `N${id}`, maxRanks }], prereqs: [] });
  const catalog = (dir: string, version: string, ranks: number) => {
    mkdirSync(dir, { recursive: true });
    for (const cls of ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"]) {
      writeFileSync(
        join(dir, `${cls}.json`),
        JSON.stringify({ schema: "everloot.talent-catalog/2", build: { version, buildId: Number(version.split(".")[3]), buildConfig: "c", definitions: "d", extractedAt: "t" }, classId: 1, className: cls[0]!.toUpperCase() + cls.slice(1), pointLevels: [10, 11, 12], trees: [{ id: 1, name: "Tree", order: 0, nodes: [node(1, 1), node(2, ranks)] }] }),
      );
    }
  };
  const run = (extra: string[]) => spawnSync("node", [CATALOG, ...extra], { encoding: "utf8" });

  it("records the compatibility only after proving the layouts are identical", () => {
    const dir = join(root, "layout");
    catalog(join(dir, "cat1"), "1.0.0.1", 3);
    catalog(join(dir, "cat2"), "1.0.0.2", 3);
    expect(run([join(dir, "cat1"), "--commit", "a", "--out", join(dir, "out1")]).status).toBe(0);
    const ok = run([join(dir, "cat2"), "--commit", "b", "--out", join(dir, "out2"), "--previous", join(dir, "out1"), "--layout-compatible", "1.0.0.1"]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "out2", "priest.json"), "utf8")).build).toEqual({ version: "1.0.0.2", buildId: 2, layoutCompatibleWith: ["1.0.0.1"] });
  });

  it("refuses to declare compatibility when anything in the layout changed", () => {
    const dir = join(root, "layout-diff");
    catalog(join(dir, "cat1"), "1.0.0.1", 3);
    catalog(join(dir, "cat2"), "1.0.0.2", 2); // a rank changed
    expect(run([join(dir, "cat1"), "--commit", "a", "--out", join(dir, "out1")]).status).toBe(0);
    const res = run([join(dir, "cat2"), "--commit", "b", "--out", join(dir, "out2"), "--previous", join(dir, "out1"), "--layout-compatible", "1.0.0.1"]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/layout differs/);
    expect(existsSync(join(dir, "out2", "priest.json"))).toBe(false);
  });

  it("needs --previous, and the previous output must be the build it names", () => {
    const dir = join(root, "layout-args");
    catalog(join(dir, "cat1"), "1.0.0.1", 3);
    expect(run([join(dir, "cat1"), "--commit", "a", "--out", join(dir, "o"), "--layout-compatible", "1.0.0.0"]).status).not.toBe(0);
    expect(run([join(dir, "cat1"), "--commit", "a", "--out", join(dir, "o1")]).status).toBe(0);
    expect(run([join(dir, "cat1"), "--commit", "a", "--out", join(dir, "o2"), "--previous", join(dir, "o1"), "--layout-compatible", "1.0.0.9"]).status).not.toBe(0);
  });
});
