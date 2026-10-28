#!/usr/bin/env node
// Converts a client-extracted talent catalog (Everloot "everloot.talent-catalog/2", one JSON file per class)
// into AzerDex's own versioned talent format (src/lib/talents/types.ts) plus a provenance manifest.
//
//   node scripts/import-talent-catalog.mjs <catalogDir> --commit <sha> [--out <dir>]
//        [--previous <dir of the previous build's output> --layout-compatible <previous build version>]
//
// --layout-compatible: declares that this build's talent layout is IDENTICAL to the previous build's, so share links made for
// that build stay valid (build-code.ts accepts their layout hash). It is accepted only after this script has compared every
// class, tree, talent (ids, names, spell ids, positions, ranks, gates, prerequisites) with --previous and found no difference;
// any difference is an error. Nothing is relabelled: the data keeps its own build.
//
// <catalogDir> holds druid.json ... warrior.json. Nothing is added, guessed or edited by hand: every field
// is copied or mechanically derived, and the manifest records the sha256 of each source and output file so
// the result can be re-verified. See docs/web/class-guides-talents.md for how to update the data.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CLASSES = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"];
const SOURCE_SCHEMA = "everloot.talent-catalog/2";
const OUT_SCHEMA = "azerdex.talent-class/1";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const dir = process.argv[2];
const commit = arg("commit");
if (!dir || dir.startsWith("--") || !commit) {
  console.error("usage: import-talent-catalog.mjs <catalogDir> --commit <sha> [--out <dir>]");
  process.exit(2);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const sources = new Map();
let build = null;
const outputs = [];

for (const cls of CLASSES) {
  const raw = readFileSync(join(dir, `${cls}.json`));
  const src = JSON.parse(raw.toString("utf8"));
  if (src.schema !== SOURCE_SCHEMA) throw new Error(`${cls}: unexpected source schema ${src.schema}`);
  if (src.className.toLowerCase() !== cls) throw new Error(`${cls}: class mismatch (${src.className})`);
  if (build && build.version !== src.build.version) throw new Error(`${cls}: build ${src.build.version} differs from ${build.version}`);
  build = src.build;
  sources.set(cls, sha256(raw));

  const levels = src.pointLevels;
  // The calculator derives "required level" as firstPointLevel + points - 1, which is only right for one point per level.
  if (!levels.every((l, i) => i === 0 || l === levels[i - 1] + 1)) throw new Error(`${cls}: point levels are not one point per consecutive level`);
  const names = new Map();
  for (const t of src.trees) for (const n of t.nodes) names.set(n.id, n.entries[0]?.name ?? null);

  const trees = [...src.trees]
    .sort((a, b) => a.order - b.order)
    .map((t) => {
      const talents = [...t.nodes]
        .sort((a, b) => a.row - b.row || a.col - b.col || a.id - b.id)
        .map((n) => {
          if (n.kind !== "single" || n.entries.length !== 1) throw new Error(`${cls}/${t.name}/${n.id}: only single-entry nodes are supported (got ${n.kind})`);
          const entry = n.entries[0];
          if (!entry.name) throw new Error(`${cls}/${t.name}/${n.id}: unnamed talent`);
          const gate = n.unlock?.spentRequired;
          const requires = n.prereqs.map((p) => ({ talentId: p.nodeId, rule: p.rule }));
          for (const r of n.unlock?.ranksInNodes ?? []) {
            // A rank gate on another node. When it repeats a prerequisite already listed (as it does for Venom -> Mutilate),
            // keep only the prerequisite; otherwise carry it as an explicit minimum rank.
            if (!requires.some((q) => q.talentId === r.nodeId)) requires.push({ talentId: r.nodeId, rule: "all", minRank: r.ranks });
          }
          return {
            id: n.id,
            name: entry.name,
            spellId: entry.spellId,
            row: n.row,
            col: n.col,
            maxRank: n.maxRanks,
            // Points that must already be spent in this tree on the rows above. Absent for the first row.
            ...(gate ? { pointsRequired: gate.amount, pointsRequiredScope: gate.scope === "tree" ? "tree" : "assumed-tree" } : {}),
            ...(requires.length ? { requires } : {}),
          };
        });
      return {
        id: t.id,
        name: t.name,
        slug: slugify(t.name),
        rows: Math.max(...talents.map((x) => x.row)) + 1,
        cols: Math.max(...talents.map((x) => x.col)) + 1,
        talents,
      };
    });

  const out = {
    schema: OUT_SCHEMA,
    classId: cls,
    className: src.className,
    gameClassId: src.classId,
    build: { version: build.version, buildId: build.buildId },
    pointBudget: { total: levels.length, firstPointLevel: levels[0], lastPointLevel: levels[levels.length - 1] },
    trees,
  };
  outputs.push([cls, out]);
}

const compatible = arg("layout-compatible");
const previousDir = arg("previous");
if (compatible && !previousDir) throw new Error("--layout-compatible needs --previous <dir>");
if (compatible) {
  const strip = (o) => JSON.stringify({ ...o, build: undefined });
  for (const [cls, out] of outputs) {
    const prev = JSON.parse(readFileSync(join(resolve(previousDir), `${cls}.json`), "utf8"));
    if (prev.build.version !== compatible) throw new Error(`${cls}: previous output is build ${prev.build.version}, not ${compatible}`);
    if (strip(prev) !== strip(out)) throw new Error(`${cls}: layout differs from build ${compatible}; refusing to declare compatibility`);
    out.build = { ...out.build, layoutCompatibleWith: [compatible] };
  }
}

const outDir = resolve(arg("out") ?? join("src", "data", "talents", "forever", build.version));
mkdirSync(outDir, { recursive: true });
const outHashes = {};
for (const [cls, out] of outputs) {
  const text = `${JSON.stringify(out, null, 2)}\n`;
  writeFileSync(join(outDir, `${cls}.json`), text);
  outHashes[cls] = sha256(text);
}

const manifest = {
  schema: "azerdex.talent-manifest/1",
  game: "World of Warcraft: Forever",
  build: { version: build.version, buildId: build.buildId, buildConfig: build.buildConfig, extractedAt: build.extractedAt, tableDefinitions: build.definitions },
  source: {
    name: "Everloot talent catalog (trimmed game-data files)",
    repository: "https://github.com/Everloot/everloot",
    commit,
    path: "web/src/data/game-data/talents/<class>.json",
    schema: SOURCE_SCHEMA,
    label: "found in game files, unconfirmed",
    note: "Read by the source project from the Forever client's trait tables. Game data (c) Blizzard Entertainment, Inc.; not covered by this repository's licence.",
    sha256: Object.fromEntries(sources),
  },
  output: { sha256: outHashes },
};
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outputs.length} class files + manifest to ${outDir} (build ${build.version})`);
