#!/usr/bin/env node
// Rebuilds the two editorial illustrations and their responsive WebP variants.
//
//   cd web && node scripts/content-art/build.mjs
//
// Output (web/public/content-images/blog/):
//   <slug>.webp          1920x1080 hero master (desktop/tablet)
//   <slug>-mobile.webp    810x1080 portrait crop around the focal subject (phones)
//   <slug>-card.webp      800x600  4:3 card thumbnail
//   <slug>-social.webp   1200x630  Open Graph / Twitter large-image crop
//
// The artwork is original, procedurally authored SVG (see ./lib.mjs and the scene-*.mjs files); it uses no
// third-party imagery and contains no text. Output is deterministic. See docs/azerdex-blog-articles-art/provenance.md.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { renderSvgToPng } from "./render.mjs";
import { buildBeginnersGuideSvg } from "./scene-beginners-guide.mjs";
import { buildRaceClassSvg } from "./scene-race-class.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "public", "content-images", "blog");
mkdirSync(OUT, { recursive: true });

// Per scene: where the mobile (810x1080) and card (1440x1080) crops start on the 1920x1080 master.
const SCENES = [
  { slug: "wow-forever-beginners-guide-2026", svg: buildBeginnersGuideSvg, mobileX: 1040, cardX: 480 },
  { slug: "wow-forever-new-race-class-combinations", svg: buildRaceClassSvg, mobileX: 1090, cardX: 480 },
];

const tmp = mkdtempSync(join(tmpdir(), "azerdex-art-"));
try {
  for (const sc of SCENES) {
    const png = join(tmp, `${sc.slug}.png`);
    await renderSvgToPng(sc.svg(), png);
    const base = () => sharp(png);
    const webp = (p, o = {}) => p.webp({ quality: 86, effort: 6, smartSubsample: true, ...o });
    await webp(base()).toFile(join(OUT, `${sc.slug}.webp`));
    await webp(base().extract({ left: sc.mobileX, top: 0, width: 810, height: 1080 })).toFile(join(OUT, `${sc.slug}-mobile.webp`));
    await webp(base().extract({ left: sc.cardX, top: 0, width: 1440, height: 1080 }).resize(800, 600)).toFile(join(OUT, `${sc.slug}-card.webp`));
    await webp(base().extract({ left: 0, top: 36, width: 1920, height: 1008 }).resize(1200, 630)).toFile(join(OUT, `${sc.slug}-social.webp`));
    console.log("built", sc.slug);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
