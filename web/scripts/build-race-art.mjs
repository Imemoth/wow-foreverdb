#!/usr/bin/env node
/**
 * Encode the owner-provided race illustrations (10 PNGs, 1086x1448, 3:4) into the same-origin WebP set under public/race-cards/.
 *
 *   node scripts/build-race-art.mjs <dir with the ten source PNGs>
 *
 * Per race: `<slug>-240.webp` (thumbnails), `<slug>-540.webp` (cards, phone hero), `<slug>-800.webp` (high-density cards, desktop hero)
 * and `<slug>.webp` (native 1086 px). The aspect ratio is never changed and nothing is upscaled. Prints sizes and SHA-256 of every source and output
 * (these are pinned in tests/unit/race-art.test.ts and listed in docs/web/race-art.md). The source PNGs are not committed.
 * `sharp` is not a dependency of this project; it comes with Next.js. Run from `web/`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";

/** Source file name (as delivered by the owner) -> race slug. */
const SOURCES = {
  "Human.png": "human", "dwarf.png": "dwarf", "night-elf.png": "night-elf", "gnome.png": "gnome",
  "High-Order-Skyborne.png": "high-order-skyborne", "orc.png": "orc", "tauren.png": "tauren", "troll.png": "troll",
  "undead.png": "undead", "Windshaper-Skyborne.png": "windshaper-skyborne",
};
const WIDTHS = [240, 540, 800, 1086]; // 1086 is the native width: encoded without resizing
const QUALITY = 80;
const SRC_W = 1086, SRC_H = 1448;

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/build-race-art.mjs <source dir>"); process.exit(2); }
const out = resolve(process.cwd(), "public", "race-cards");
mkdirSync(out, { recursive: true });
const sha = (b) => createHash("sha256").update(b).digest("hex");

const rows = [];
for (const [file, slug] of Object.entries(SOURCES)) {
  const path = join(dir, file);
  if (!existsSync(path)) { console.error(`missing source: ${file}`); process.exit(1); }
  const buf = readFileSync(path);
  const meta = await sharp(buf).metadata();
  if (meta.width !== SRC_W || meta.height !== SRC_H) { console.error(`${file}: expected ${SRC_W}x${SRC_H}, got ${meta.width}x${meta.height}`); process.exit(1); }
  for (const w of WIDTHS) {
    const name = w === SRC_W ? `${slug}.webp` : `${slug}-${w}.webp`;
    const img = w === SRC_W ? sharp(buf) : sharp(buf).resize({ width: w, kernel: "lanczos3", withoutEnlargement: true });
    const data = await img.webp({ quality: QUALITY, effort: 6 }).toBuffer();
    writeFileSync(join(out, name), data);
    const m = await sharp(data).metadata();
    rows.push({ slug, name, width: m.width, height: m.height, bytes: data.length, sha256: sha(data), source: file, sourceSha256: sha(buf) });
  }
}
console.log(JSON.stringify(rows, null, 1));
const total = rows.reduce((n, r) => n + r.bytes, 0);
console.error(`${rows.length} files, ${(total / 1024).toFixed(0)} KiB total`);
