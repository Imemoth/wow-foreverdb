#!/usr/bin/env node
// Builds the original cover art for the "World First: Level 60" editorial and exports the four standard
// responsive WebP variants (same sizes as scripts/content-art/export-covers.mjs).
//
//   cd web && node scripts/content-art/build-world-first-60-art.mjs
//
// The scene is authored entirely in code (vector shapes, gradients, a seeded particle field): no photograph, no
// third-party image, no game asset and no AI-generated raster is used, so there is nothing to license or attribute.
// Five silhouettes (three Mages, a Paladin, a Shaman) stand on a ridge under an arcane moon while an Arcane
// Explosion shockwave rolls out from their feet. It contains no text: all typography is HTML.
//
// This is the FALLBACK art (files end in -art): the primary cover is the owner-supplied poster, see export-world-first-60-poster.mjs.
// Output (web/public/content-images/news/), cut from one 1920x1080 render:
//   <slug>-art.webp     1920x1080  fallback hero
//   <slug>-mobile.webp   810x1080  portrait crop around the party
//   <slug>-card.webp     800x600   4:3 thumbnail
//   <slug>-social.webp  1200x630   og:image / twitter:image
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SLUG = "jokerd-team-world-first-level-60-wow-forever";
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "..", "public", "content-images", "news");
const W = 1920, H = 1080;

// Deterministic PRNG so the art is reproducible byte-for-byte.
let seed = 6060;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const f = (n) => n.toFixed(1);

const RIM = "#b79cf5";
const INK = "#04051a";

function stars() {
  let s = "";
  for (let i = 0; i < 260; i++) {
    const x = rnd() * W, y = rnd() * 560, r = 0.5 + rnd() * 1.5, o = 0.25 + rnd() * 0.7;
    s += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="#ece6d9" opacity="${f(o)}"/>`;
  }
  return s;
}

function embers() {
  let s = "";
  for (let i = 0; i < 90; i++) {
    const x = 760 + rnd() * 1160, y = 380 + rnd() * 560, r = 1 + rnd() * 3;
    const gold = rnd() > 0.45;
    s += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${gold ? "#f0dfae" : "#c3aef2"}" opacity="${f(0.35 + rnd() * 0.6)}" filter="url(#soft)"/>`;
  }
  return s;
}

function ridge(points, fill, opacity = 1) {
  return `<path d="M0,${H} L${points.map(([x, y]) => `${x},${y}`).join(" L")} L${W},${H} Z" fill="${fill}" opacity="${opacity}"/>`;
}

function spire(x, base, h, w, fill) {
  // A ruined gothic tower: shaft, pointed roof, broken battlement and a lit window.
  return `<g fill="${fill}"><path d="M${x - w / 2},${base} V${base - h} L${x},${base - h - w * 1.6} L${x + w / 2},${base - h} V${base} Z"/>
  <path d="M${x - w * 0.9},${base} V${base - h * 0.45} h${w * 0.4} v${-h * 0.08} h${w * 0.4} V${base} Z"/></g>
  <rect x="${x - 3}" y="${base - h * 0.7}" width="6" height="14" fill="#f0dfae" opacity="0.7" filter="url(#soft)"/>`;
}

function orb(x, y, r, color) {
  return `<circle cx="${x}" cy="${y}" r="${r * 4}" fill="${color}" opacity="0.28" filter="url(#glow)"/>
  <circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="0.95"/><circle cx="${x}" cy="${y}" r="${r * 1.7}" fill="${color}" opacity="0.55" filter="url(#soft)"/>`;
}

const rim = `stroke="${RIM}" stroke-opacity="0.6" stroke-width="1.6" stroke-linejoin="round"`;

function mage(x, y, s, flip = 1) {
  return `<g transform="translate(${x},${y}) scale(${s * flip},${s})">
    <path d="M-30,0 L-20,-118 Q-26,-150 -13,-170 L13,-170 Q26,-150 20,-118 L31,0 Z" fill="${INK}" ${rim}/>
    <path d="M-14,-150 Q-60,-110 -52,-20 L-30,-30 Z" fill="${INK}" opacity="0.9"/>
    <circle cx="0" cy="-184" r="13" fill="${INK}" ${rim}/>
    <path d="M-27,-192 Q0,-203 27,-192 L4,-268 Q-2,-276 -8,-262 Z" fill="${INK}" ${rim}/>
    <path d="M12,-150 Q40,-176 58,-214" fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>
    <path d="M12,-150 Q40,-176 58,-214" fill="none" stroke="${RIM}" stroke-opacity="0.45" stroke-width="1.4"/>
    ${orb(60, -218, 7, "#9b74e6")}
    <line x1="-42" y1="0" x2="-42" y2="-246" stroke="${INK}" stroke-width="6"/>
    <line x1="-42" y1="0" x2="-42" y2="-246" stroke="${RIM}" stroke-opacity="0.4" stroke-width="1.2"/>
    ${orb(-42, -252, 8, "#6cbcef")}
  </g>`;
}

function paladin(x, y, s) {
  return `<g transform="translate(${x},${y}) scale(${s})">
    <circle cx="0" cy="-170" r="150" fill="#f0dfae" opacity="0.14" filter="url(#glow)"/>
    <path d="M-38,0 L-32,-108 L-52,-150 L-22,-172 L22,-172 L52,-150 L32,-108 L38,0 Z" fill="${INK}" ${rim}/>
    <path d="M-24,-172 Q-26,-214 0,-216 Q26,-214 24,-172 Z" fill="${INK}" ${rim}/>
    <path d="M-5,-216 Q0,-236 5,-216" fill="none" stroke="${RIM}" stroke-opacity="0.6" stroke-width="3"/>
    <rect x="-16" y="-198" width="32" height="4" fill="#f0dfae" opacity="0.8" filter="url(#soft)"/>
    <path d="M-92,-150 L-56,-160 L-56,-62 Q-74,-26 -92,-14 Q-110,-30 -110,-62 Z" fill="${INK}" stroke="#d9b978" stroke-opacity="0.75" stroke-width="2"/>
    <line x1="-92" y1="-138" x2="-92" y2="-34" stroke="#d9b978" stroke-opacity="0.6" stroke-width="2"/>
    <path d="M44,-140 L84,-262" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
    <g transform="translate(84,-262) rotate(24)"><circle r="46" fill="#f0dfae" opacity="0.3" filter="url(#glow)"/>
      <path d="M-40,-22 L-26,-26 L26,-26 L40,-22 L40,22 L26,26 L-26,26 L-40,22 Z" fill="${INK}" stroke="#f0dfae" stroke-width="2.6" stroke-linejoin="round"/>
      <line x1="-14" y1="-20" x2="-14" y2="20" stroke="#f0dfae" stroke-opacity="0.7" stroke-width="2"/><line x1="14" y1="-20" x2="14" y2="20" stroke="#f0dfae" stroke-opacity="0.7" stroke-width="2"/></g>
  </g>`;
}

function shaman(x, y, s) {
  const feathers = [-30, -15, 0, 15, 30].map((a) => `<path d="M0,-212 L${f(Math.sin((a * Math.PI) / 180) * 54)},${f(-212 - Math.cos((a * Math.PI) / 180) * 54)}" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`).join("");
  return `<g transform="translate(${x},${y}) scale(${s})">
    <path d="M-34,0 L-24,-100 L-44,-140 L-14,-164 L14,-164 L44,-140 L26,-100 L36,0 Z" fill="${INK}" ${rim}/>
    <circle cx="0" cy="-182" r="14" fill="${INK}" ${rim}/>
    ${feathers}
    <path d="M14,-146 Q46,-170 62,-206" fill="none" stroke="${INK}" stroke-width="11" stroke-linecap="round"/>
    <line x1="-48" y1="0" x2="-48" y2="-232" stroke="${INK}" stroke-width="7"/>
    <line x1="-48" y1="0" x2="-48" y2="-232" stroke="${RIM}" stroke-opacity="0.4" stroke-width="1.2"/>
    <path d="M-48,-232 l-12,-14 l12,6 l12,-6 Z" fill="${INK}"/>
    <path d="M-48,-246 l-10,-38 M-48,-246 l10,-38" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
    <path d="M-48,-250 L-70,-300 L-52,-296 L-76,-352 M-48,-250 L-18,-290 L-34,-288 L-8,-330" fill="none" stroke="#6cbcef" stroke-width="3" stroke-linecap="round" filter="url(#soft)"/>
    ${orb(-48, -250, 6, "#6cbcef")}
    ${orb(64, -210, 6, "#6cbcef")}
  </g>`;
}

function shockwave(cx, cy) {
  let s = "";
  for (let i = 0; i < 7; i++) {
    const rx = 90 + i * 118, ry = 18 + i * 25, o = 0.85 - i * 0.1;
    s += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${i % 2 ? "#c3aef2" : "#9b74e6"}" stroke-width="${f(5 - i * 0.5)}" opacity="${f(o)}" filter="url(#soft)"/>`;
  }
  return `<ellipse cx="${cx}" cy="${cy}" rx="560" ry="110" fill="url(#burst)"/>${s}`;
}

function runeRing(cx, cy, r, ticks, dash) {
  let t = "";
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    t += `<line x1="${f(cx + Math.cos(a) * r)}" y1="${f(cy + Math.sin(a) * r)}" x2="${f(cx + Math.cos(a) * (r + (i % 3 === 0 ? 20 : 10)))}" y2="${f(cy + Math.sin(a) * (r + (i % 3 === 0 ? 20 : 10)))}" stroke="#d9b978" stroke-opacity="0.7" stroke-width="2"/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#d9b978" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="${dash}"/>${t}`;
}

const MOON = { x: 1390, y: 300 };
const GROUND = 905;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#05061a"/><stop offset="0.45" stop-color="#14104a"/><stop offset="0.75" stop-color="#3a2188"/><stop offset="1" stop-color="#7a4bb5"/>
  </linearGradient>
  <radialGradient id="moon" cx="0.42" cy="0.4" r="0.7"><stop offset="0" stop-color="#fffaf0"/><stop offset="0.55" stop-color="#f0dfae"/><stop offset="1" stop-color="#b9965a"/></radialGradient>
  <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#c3aef2" stop-opacity="0.55"/><stop offset="0.5" stop-color="#6c41c7" stop-opacity="0.22"/><stop offset="1" stop-color="#6c41c7" stop-opacity="0"/></radialGradient>
  <radialGradient id="burst" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#e3d6fb" stop-opacity="0.85"/><stop offset="0.4" stop-color="#9b74e6" stop-opacity="0.4"/><stop offset="1" stop-color="#6c41c7" stop-opacity="0"/></radialGradient>
  <linearGradient id="fog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a4bb5" stop-opacity="0"/><stop offset="1" stop-color="#9b74e6" stop-opacity="0.5"/></linearGradient>
  <linearGradient id="ray" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0dfae" stop-opacity="0.22"/><stop offset="1" stop-color="#f0dfae" stop-opacity="0"/></linearGradient>
  <radialGradient id="vig" cx="0.62" cy="0.55" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#02030f" stop-opacity="0.78"/></radialGradient>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>
  <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="22"/></filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
${stars()}
<circle cx="${MOON.x}" cy="${MOON.y}" r="430" fill="url(#halo)"/>
<polygon points="${MOON.x - 40},${MOON.y} ${MOON.x + 40},${MOON.y} ${MOON.x + 360},${GROUND} ${MOON.x - 360},${GROUND}" fill="url(#ray)"/>
<circle cx="${MOON.x}" cy="${MOON.y}" r="150" fill="url(#moon)" opacity="0.92"/>
<g fill="#b9965a" opacity="0.35"><circle cx="${MOON.x - 40}" cy="${MOON.y - 30}" r="26"/><circle cx="${MOON.x + 50}" cy="${MOON.y + 40}" r="18"/><circle cx="${MOON.x + 10}" cy="${MOON.y - 80}" r="12"/></g>
${runeRing(MOON.x, MOON.y, 205, 48, "3 9")}
${runeRing(MOON.x, MOON.y, 262, 72, "1 7")}
${ridge([[0, 640], [180, 600], [380, 650], [560, 560], [760, 640], [980, 590], [1210, 650], [1500, 580], [1720, 640], [W, 600]], "#1a1458", 0.9)}
${ridge([[0, 720], [240, 690], [470, 730], [700, 660], [960, 740], [1240, 700], [1480, 750], [1720, 700], [W, 740]], "#100c3d", 0.95)}
${spire(210, 740, 150, 46, "#0a0830")}${spire(300, 745, 96, 34, "#0a0830")}${spire(468, 735, 120, 40, "#0a0830")}${spire(150, 750, 70, 28, "#0a0830")}
<rect x="0" y="560" width="${W}" height="360" fill="url(#fog)"/>
${ridge([[0, 880], [420, 860], [760, 870], [1000, 905], [1500, 910], [W, 895]], "#070722")}
<ellipse cx="1420" cy="${GROUND + 6}" rx="780" ry="46" fill="#9b74e6" opacity="0.18" filter="url(#glow)"/>
${shockwave(1415, GROUND + 4)}
${mage(1100, GROUND + 6, 1.0)}
${mage(1240, GROUND + 12, 1.08)}
${paladin(1450, GROUND + 18, 1.32)}
${mage(1635, GROUND + 12, 1.08, -1)}
${shaman(1775, GROUND + 6, 1.02)}
${embers()}
<rect width="${W}" height="${H}" fill="url(#vig)"/>
</svg>`;

mkdirSync(OUT, { recursive: true });
const master = await sharp(Buffer.from(svg), { density: 96 }).resize(W, H).png().toBuffer();
const enc = (img) => img.webp({ quality: 88, effort: 6, smartSubsample: true });
const crop = (left, top, width, height) => sharp(master).extract({ left, top, width, height });
await enc(sharp(master)).toFile(join(OUT, `${SLUG}-art.webp`));
await enc(crop(1050, 0, 810, 1080)).toFile(join(OUT, `${SLUG}-art-mobile.webp`));
await enc(crop(480, 0, 1440, 1080).resize(800, 600, { kernel: "lanczos3" })).toFile(join(OUT, `${SLUG}-art-card.webp`));
await enc(crop(0, 36, 1920, 1008).resize(1200, 630, { kernel: "lanczos3" })).toFile(join(OUT, `${SLUG}-art-social.webp`));
console.log("exported", SLUG);
