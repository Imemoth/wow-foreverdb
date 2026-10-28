#!/usr/bin/env node
// Validates a talent icon package and writes the icon manifest (icons.json) and its inventory for one game build.
//
//   node scripts/import-talent-icons.mjs --dataset src/data/talents/forever/<build> \
//     --mapping <icons-<build>.json: { build, icons: { "<spellId>": <FileDataID> } }> \
//     --snapshot <client-talents.json: per-talent iconFileDataId read from the client's SpellMisc> \
//     --images <dir containing talent-icons/<build>/<FileDataID>.webp> --inventory <asset-inventory.csv> [--check]
//
// The images themselves are Blizzard-owned and are NEVER written to the repository: only ids and sha256 hashes are. Nothing is
// written unless every rule holds:
//   - the mapping's build equals the dataset's build (a manifest is never relabelled to another build);
//   - every talent's spell id is mapped, to the same FileDataID the client snapshot reports for that talent;
//   - there is exactly one image per distinct FileDataID: WebP, 64x64, sha256 equal to the owner's inventory, decodable.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const need = (n) => {
  const v = arg(n);
  if (!v) {
    console.error(`missing --${n}; see the header of scripts/import-talent-icons.mjs`);
    process.exit(2);
  }
  return v;
};
const datasetDir = resolve(need("dataset"));
const mapping = JSON.parse(readFileSync(resolve(need("mapping")), "utf8"));
const snapshot = JSON.parse(readFileSync(resolve(need("snapshot")), "utf8"));
const imagesDir = resolve(need("images"));
const inventoryCsv = readFileSync(resolve(need("inventory")), "utf8");
const checkOnly = process.argv.includes("--check");

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const manifest = JSON.parse(readFileSync(join(datasetDir, "manifest.json"), "utf8"));
const build = manifest.build.version;
const problems = [];
const bad = (m) => problems.push(m);

if (mapping.build !== build) bad(`mapping is for build ${mapping.build}, the dataset is ${build}; refusing to relabel it`);
if (mapping.schema !== undefined && mapping.schema !== "azerdex.talent-icons/1") bad(`unexpected mapping schema ${mapping.schema}`);

// talents of the dataset
const talents = [];
for (const cls of Object.keys(manifest.output.sha256)) for (const t of JSON.parse(readFileSync(join(datasetDir, `${cls}.json`), "utf8")).trees.flatMap((x) => x.talents)) talents.push({ ...t, classId: cls });
const snapByNode = new Map(snapshot.talents.map((t) => [t.nodeId, t]));
const validId = (n) => Number.isInteger(n) && n > 0 && n < 2 ** 31;
const ids = new Set();
for (const t of talents) {
  const fid = mapping.icons[String(t.spellId)];
  const s = snapByNode.get(t.id);
  if (!validId(fid)) bad(`${t.classId}/${t.name} (${t.id}): spell ${t.spellId} has no valid FileDataID`);
  if (!s) bad(`${t.name} (${t.id}): not in the client snapshot`);
  else if (s.spellId !== t.spellId) bad(`${t.name}: snapshot spell ${s.spellId} != dataset ${t.spellId}`);
  else if (s.iconFileDataId !== fid) bad(`${t.name}: mapping ${fid} != client SpellMisc ${s.iconFileDataId}`);
  ids.add(fid);
}
const extra = Object.keys(mapping.icons).filter((k) => !talents.some((t) => String(t.spellId) === k));
if (extra.length) bad(`mapping has spell ids that are not talents: ${extra.slice(0, 5).join(", ")}`);

// the owner's inventory (sha256 of the BLP source and the WebP, dimensions)
const inv = new Map();
for (const line of inventoryCsv.trim().split(/\r?\n/).slice(1)) {
  const [id, w, h, alpha, blpBytes, webpBytes, blpSha, webpSha] = line.split(",");
  inv.set(Number(id), { width: Number(w), height: Number(h), alpha: alpha === "True", blpBytes: Number(blpBytes), webpBytes: Number(webpBytes), blpSha256: blpSha, webpSha256: webpSha });
}
if (inv.size !== ids.size || [...ids].some((i) => !inv.has(i))) bad(`inventory covers ${inv.size} ids, the mapping uses ${ids.size}`);

function webpSize(b) {
  if (b.length < 30 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8L" && b[20] === 0x2f) return { w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | (b[22] >> 6)) };
  if (kind === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (kind === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  return null;
}
let sharp = null;
try {
  sharp = createRequire(join(here, "..", "package.json"))("sharp");
} catch {
  console.warn("sharp is not installed: images are checked by header and sha256 only");
}
const files = {};
let decoded = 0;
for (const id of [...ids].sort((a, b) => a - b)) {
  const p = join(imagesDir, "talent-icons", build, `${id}.webp`);
  if (!existsSync(p)) { bad(`missing image ${p}`); continue; }
  const b = readFileSync(p);
  const size = webpSize(b);
  if (!size || size.w !== 64 || size.h !== 64) bad(`${id}.webp: not a 64x64 WebP (${JSON.stringify(size)})`);
  const rec = inv.get(id);
  if (rec && sha256(b) !== rec.webpSha256) bad(`${id}.webp: sha256 differs from the inventory`);
  if (rec && b.length !== rec.webpBytes) bad(`${id}.webp: ${b.length} bytes, inventory says ${rec.webpBytes}`);
  if (sharp) {
    try {
      const { data, info } = await sharp(b).raw().toBuffer({ resolveWithObject: true });
      if (info.width !== 64 || info.height !== 64 || data.length !== 64 * 64 * info.channels) bad(`${id}.webp: decoded to ${info.width}x${info.height}`);
      else decoded++;
    } catch (e) { bad(`${id}.webp: does not decode (${e.message})`); }
  }
  files[id] = { webpSha256: sha256(b), webpBytes: b.length, width: 64, height: 64, hasAlpha: rec?.alpha ?? null, sourceBlpSha256: rec?.blpSha256 ?? null };
}
if (talents.length !== 466 && !process.argv.includes("--allow-any-count")) bad(`expected 466 talents, got ${talents.length}`);
if (problems.length) {
  console.error("validation failed; nothing written:\n" + problems.slice(0, 30).join("\n"));
  process.exit(1);
}

const icons = Object.fromEntries(Object.entries(mapping.icons).sort(([a], [b]) => Number(a) - Number(b)));
const out = { schema: "azerdex.talent-icons/1", build, icons };
const inventory = {
  schema: "azerdex.talent-icon-inventory/1",
  build,
  note: "Hashes and sizes only. The images are Blizzard-owned game art and are not part of this repository; they are served from the allow-listed asset host under talent-icons/<build>/<FileDataID>.webp once publication is approved.",
  source: { clientBuild: snapshot.talents[0]?.sourceGameBuild ?? null, snapshotSchema: snapshot.schema, mappingSha256: sha256(readFileSync(resolve(need("mapping")))), inventorySha256: sha256(Buffer.from(inventoryCsv)) },
  talents: talents.length,
  uniqueImages: ids.size,
  files,
};
console.log(JSON.stringify({ build, talentsMapped: talents.length, uniqueImages: ids.size, decodedWithSharp: sharp ? decoded : "skipped" }));
if (checkOnly) {
  console.log("--check: validation passed, nothing written");
  process.exit(0);
}
writeFileSync(join(datasetDir, "icons.json"), JSON.stringify(out, null, 1) + "\n");
writeFileSync(join(datasetDir, "icons-inventory.json"), JSON.stringify(inventory, null, 1) + "\n");
console.log("written: icons.json, icons-inventory.json");
