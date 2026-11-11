#!/usr/bin/env node
// Exports the four responsive WebP variants of the owner-supplied "World First 60" poster (1672x941 master).
//
//   cd web && node scripts/content-art/export-world-first-60-poster.mjs
//
// Same sizes and method as export-covers.mjs: crop to each output's exact aspect, one lanczos3 resize, WebP q80; nothing
// is stretched or repainted. The poster carries its own baked-in headline and badges, so the hero shows it uncropped
// (the 1920x1080 file is a ~1.15x upscale); the mobile slot reuses the hero file (no separate crop). Card and social are crops.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SLUG = "jokerd-team-world-first-level-60-wow-forever";
const here = dirname(fileURLToPath(import.meta.url));
const MASTER = resolve(here, "..", "..", "..", "docs", "azerdex-world-first-art", "masters", `${SLUG}.webp`);
const OUT = resolve(here, "..", "..", "public", "content-images", "news");
const SRC_W = 1672, SRC_H = 941;
const meta = await sharp(MASTER).metadata();
if (meta.width !== SRC_W || meta.height !== SRC_H) throw new Error(`expected ${SRC_W}x${SRC_H}, got ${meta.width}x${meta.height}`);
const src = () => sharp(MASTER).removeAlpha();
const enc = (img) => img.webp({ quality: 80, effort: 6, smartSubsample: true });
const rs = (img, w, h) => img.resize(w, h, { fit: "fill", kernel: "lanczos3" });
// hero: master is 0.05% narrower than 16:9, so trim one pixel row rather than stretch
await enc(rs(src().extract({ left: 0, top: 0, width: SRC_W, height: 940 }), 1920, 1080)).toFile(join(OUT, `${SLUG}.webp`));
// card 4:3 (1255x941) centred on the paladin; social 1672x878 keeps the headline and badges (y 20..898)
await enc(rs(src().extract({ left: 210, top: 0, width: 1255, height: 941 }), 800, 600)).toFile(join(OUT, `${SLUG}-card.webp`));
await enc(rs(src().extract({ left: 0, top: 20, width: SRC_W, height: 878 }), 1200, 630)).toFile(join(OUT, `${SLUG}-social.webp`));
console.log("exported", SLUG);
