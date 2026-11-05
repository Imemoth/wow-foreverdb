#!/usr/bin/env node
// Exports the four responsive WebP variants of each approved launch-article cover from its master image.
//
//   cd web && node scripts/content-art/export-covers.mjs [<masters-dir>]
//
// <masters-dir> defaults to ../docs/azerdex-blog-articles-art/masters and must hold, per article, the approved master
// (<slug>.webp or .png, 1672x941). Output goes to web/public/content-images/blog/:
//   <slug>.webp          1920x1080  hero (desktop/tablet), also cover.src in the frontmatter
//   <slug>-mobile.webp    810x1080  3:4 portrait crop around the focal subject (phones)
//   <slug>-card.webp      800x600   4:3 /blog card thumbnail
//   <slug>-social.webp   1200x630   og:image / twitter:image
//
// Every variant is a crop + resize of the master with the same lanczos3 kernel: nothing is stretched (each crop has the
// aspect ratio of its output to within 0.05%, so the resize is uniform) and nothing is repainted. The masters are 1672x941, so the 1920x1080 hero
// and the 810x1080 mobile crop are upscaled by about 1.15x; the card and social variants are downscaled.
// `sharp` is not a declared dependency; like scripts/build-race-art.mjs it comes with Next.js. Run from web/.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "..", "public", "content-images", "blog");
const MASTERS = resolve(process.argv[2] ?? join(here, "..", "..", "..", "docs", "azerdex-blog-articles-art", "masters"));

const SRC_W = 1672, SRC_H = 941;
// Crop windows on the master, chosen by eye so the focal subject is never cut:
//   mobile  = 706x941 (3:4)      card = 1255x941 (4:3)      social = 1672x878 (1200:630)
const ARTICLES = [
  // sunrise overlook: traveller x~1020-1320, props to x~1650, sun at (1070, 210)
  { slug: "wow-forever-beginners-guide-2026", mobileX: 930, cardX: 417, socialY: 40 },
  // undead knight (right), hammer head at x~740-1030, dwarf behind it
  { slug: "wow-forever-new-race-class-combinations", mobileX: 790, cardX: 417, socialY: 0 },
];

const findMaster = (slug) => ["webp", "png", "jpg"].map((e) => join(MASTERS, `${slug}.${e}`)).find(existsSync);
const enc = (img) => img.webp({ quality: 88, effort: 6, smartSubsample: true });
const resize = (img, w, h) => img.resize(w, h, { fit: "fill", kernel: "lanczos3" }); // crops are already the exact aspect

mkdirSync(OUT, { recursive: true });
for (const a of ARTICLES) {
  const file = findMaster(a.slug);
  if (!file) throw new Error(`master for ${a.slug} not found in ${MASTERS}`);
  const meta = await sharp(file).metadata();
  if (meta.width !== SRC_W || meta.height !== SRC_H) throw new Error(`${file}: expected ${SRC_W}x${SRC_H}, got ${meta.width}x${meta.height}`);
  const src = () => sharp(file).removeAlpha();
  // hero: the master is 0.05% narrower than 16:9, so trim one pixel row of height instead of stretching
  await enc(resize(src().extract({ left: 0, top: 0, width: SRC_W, height: 940 }), 1920, 1080)).toFile(join(OUT, `${a.slug}.webp`));
  await enc(resize(src().extract({ left: a.mobileX, top: 0, width: 706, height: 941 }), 810, 1080)).toFile(join(OUT, `${a.slug}-mobile.webp`));
  await enc(resize(src().extract({ left: a.cardX, top: 0, width: 1255, height: 941 }), 800, 600)).toFile(join(OUT, `${a.slug}-card.webp`));
  await enc(resize(src().extract({ left: 0, top: a.socialY, width: SRC_W, height: 878 }), 1200, 630)).toFile(join(OUT, `${a.slug}-social.webp`));
  console.log("exported", a.slug);
}
