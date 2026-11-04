// Illustration B: "Unexpected Heroes" - original AzerDex editorial artwork.
// Procedural, deterministic SVG (1920x1080). No text, logos, UI or third-party art.
// Depicts an undead holy knight (main subject), a dwarven elemental mystic, and distant orc-caster and
// gnome-priest silhouettes among storm-lit ruins. All characters are generic fantasy archetypes:
// no named character, no faction emblem, no recreation of Blizzard key art.
import { rng, f, pts, mixHex, bolt, commonDefs, cloudCluster, peak } from "./lib.mjs";

const W = 1920, H = 1080;

const boltSvg = (p, w, core, glow, extra = "") => {
  const d = `M${p.map(([x, y]) => `${f(x)},${f(y)}`).join(" L")}`;
  return `<path d="${d}" stroke="${glow}" stroke-width="${w * 5}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.55" filter="url(#b-b8)" ${extra}/>
  <path d="${d}" stroke="${glow}" stroke-width="${w * 2}" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.8" filter="url(#b-b2)" ${extra}/>
  <path d="${d}" stroke="${core}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" fill="none" ${extra}/>`;
};

function column(x, base, h, w, c, shade, broken = 0) {
  const top = base - h;
  let g = `<rect x="${f(x - w / 2)}" y="${f(top)}" width="${f(w)}" height="${f(h)}" fill="${c}"/>`;
  g += `<rect x="${f(x + w * 0.1)}" y="${f(top)}" width="${f(w * 0.4)}" height="${f(h)}" fill="${shade}" opacity="0.6"/>`;
  g += `<rect x="${f(x - w * 0.65)}" y="${f(base - h * 0.06)}" width="${f(w * 1.3)}" height="${f(h * 0.06)}" fill="${c}"/>`;
  if (!broken) g += `<rect x="${f(x - w * 0.7)}" y="${f(top - h * 0.04)}" width="${f(w * 1.4)}" height="${f(h * 0.05)}" fill="${c}"/>`;
  else g += `<polygon points="${f(x - w / 2)},${f(top)} ${f(x - w * 0.15)},${f(top - h * 0.06)} ${f(x + w * 0.1)},${f(top + h * 0.03)} ${f(x + w / 2)},${f(top - h * 0.04)} ${f(x + w / 2)},${f(top + h * 0.1)} ${f(x - w / 2)},${f(top + h * 0.1)}" fill="${c}"/>`;
  return g;
}

function archRuin(cx, base, span, h, c, shade, seed) {
  const r = rng(seed);
  const wl = span / 2;
  let g = column(cx - wl, base, h, span * 0.12, c, shade, 0) + column(cx + wl, base, h * 0.78, span * 0.12, c, shade, 1);
  // broken arch springing from the left column only
  g += `<path d="M${f(cx - wl - span * 0.06)},${f(base - h)} A${f(wl + span * 0.06)},${f(span * 0.55)} 0 0 1 ${f(cx + span * 0.12)},${f(base - h - span * 0.14)} L${f(cx + span * 0.1)},${f(base - h - span * 0.06)} A${f(wl - span * 0.04)},${f(span * 0.5)} 0 0 0 ${f(cx - wl + span * 0.06)},${f(base - h + span * 0.02)} Z" fill="${c}"/>`;
  g += `<path d="M${f(cx - wl - span * 0.06)},${f(base - h)} A${f(wl + span * 0.06)},${f(span * 0.55)} 0 0 1 ${f(cx + span * 0.12)},${f(base - h - span * 0.14)}" stroke="${shade}" stroke-width="3" fill="none" opacity="0.6"/>`;
  // fallen blocks
  for (let i = 0; i < 6; i++) g += `<rect x="${f(cx - wl + r() * span)}" y="${f(base - 12 - r() * 10)}" width="${f(24 + r() * 40)}" height="${f(14 + r() * 14)}" fill="${shade}" opacity="0.8"/>`;
  return g;
}

function banner(x, top, h, w, c, trim, seed, dir = 1) {
  const r = rng(seed);
  // pole + cloth that streams to the right on the wind, ragged lower edge
  let pts1 = [[x, top + 12], [x + dir * w * 0.5, top + 6 + r() * 6], [x + dir * w, top + 14]];
  let low = [];
  const n = 6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    low.push([x + dir * (w * (1 - t * 0.2) + Math.sin(t * 5 + seed) * 8), top + 14 + h * (0.55 + 0.45 * Math.sin(t * 3 + seed) * 0.0) - (i % 2 ? 0 : 26 * r()) + h * 0.3 * t]);
  }
  const cloth = [...pts1, ...low.reverse()];
  return `<rect x="${f(x - 3)}" y="${f(top - 20)}" width="6" height="${f(h + 120)}" fill="#0c1220"/>
  <polygon points="${pts(cloth)}" fill="${c}" filter="url(#b-wobble)"/>
  <polygon points="${f(x)},${f(top + 12)} ${f(x + dir * w)},${f(top + 14)} ${f(x + dir * w)},${f(top + 24)} ${f(x)},${f(top + 22)}" fill="${trim}" opacity="0.85"/>
  <circle cx="${f(x)}" cy="${f(top - 22)}" r="6" fill="${trim}"/>`;
}

/** Undead holy knight, in profile facing left. Origin = feet, y up is negative. */
function paladin(x, y, s) {
  const defs = `
  <linearGradient id="b-plate" gradientUnits="userSpaceOnUse" x1="-80" y1="-520" x2="80" y2="-120">
    <stop offset="0" stop-color="#c9d3e6"/><stop offset="0.3" stop-color="#7e8aa6"/><stop offset="0.7" stop-color="#37425f"/><stop offset="1" stop-color="#151c33"/></linearGradient>
  <linearGradient id="b-plate2" gradientUnits="userSpaceOnUse" x1="-60" y1="-300" x2="60" y2="0">
    <stop offset="0" stop-color="#6c7893"/><stop offset="1" stop-color="#121830"/></linearGradient>
  <linearGradient id="b-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0b8"/><stop offset="0.5" stop-color="#d9b25c"/><stop offset="1" stop-color="#7a5a24"/></linearGradient>
  <linearGradient id="b-cape" gradientUnits="userSpaceOnUse" x1="20" y1="-480" x2="260" y2="-40">
    <stop offset="0" stop-color="#34506a"/><stop offset="0.6" stop-color="#1c2c47"/><stop offset="1" stop-color="#0b1226"/></linearGradient>
  <linearGradient id="b-bone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1ead2"/><stop offset="1" stop-color="#8c8872"/></linearGradient>
  <radialGradient id="b-aura"><stop offset="0" stop-color="#ffefb0" stop-opacity="0.5"/><stop offset="0.4" stop-color="#e8cc7a" stop-opacity="0.2"/><stop offset="1" stop-color="#e8cc7a" stop-opacity="0"/></radialGradient>
  <radialGradient id="b-hammerglow"><stop offset="0" stop-color="#fff6c8" stop-opacity="0.95"/><stop offset="1" stop-color="#e8cc7a" stop-opacity="0"/></radialGradient>`;
  // cape streaming to the right, ragged hem
  const cape = "M24,-476 C70,-470 130,-440 188,-380 C236,-326 262,-250 280,-170 Q268,-150 250,-160 Q240,-120 222,-132 Q210,-92 190,-106 Q176,-64 154,-84 Q136,-44 112,-60 Q96,-22 72,-30 C60,-100 56,-200 34,-300 C26,-360 18,-420 24,-476 Z";
  const capeFold = "M60,-440 C120,-380 160,-300 168,-190 M100,-450 C170,-390 214,-300 232,-200 M40,-400 C70,-300 80,-200 78,-120";
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <defs>${defs}</defs>
    <!-- holy aura -->
    <ellipse cx="-10" cy="-300" rx="360" ry="400" fill="url(#b-aura)" style="mix-blend-mode:screen"/>
    <ellipse cx="0" cy="3" rx="160" ry="12" fill="#02050f" opacity="0.65" filter="url(#b-b4)"/>
    <!-- cape -->
    <path d="${cape}" fill="url(#b-cape)" filter="url(#b-wobble)"/>
    <path d="${capeFold}" stroke="#050a18" stroke-opacity="0.45" stroke-width="4" fill="none"/>
    <path d="${cape}" fill="none" stroke="#9fb4d8" stroke-opacity="0.45" stroke-width="2"/>
    <!-- back leg -->
    <path d="M18,-262 L46,-262 L40,-130 L52,-40 L78,-14 L70,0 L18,0 L22,-32 L8,-130 Z" fill="url(#b-plate2)"/>
    <!-- front leg: thigh, knee, greave, boot (pointing left) -->
    <path d="M-34,-268 L22,-262 L10,-150 L18,-130 L10,-48 L-6,-30 L-62,-22 L-86,-8 L-84,2 L-8,2 L-4,-40 L-34,-150 Z" fill="url(#b-plate)"/>
    <path d="M-28,-160 C-14,-170 6,-166 14,-150 L8,-128 C-6,-120 -22,-124 -32,-132 Z" fill="url(#b-gold)" stroke="#5a3d12" stroke-width="1.5"/>
        <!-- tasset and torn tabard -->
    <path d="M-52,-312 L44,-312 L58,-218 L44,-232 L30,-206 L14,-236 L-2,-200 L-18,-234 L-34,-204 L-50,-232 L-62,-218 Z" fill="url(#b-plate)"/>
    <path d="M-50,-290 L52,-290 M-54,-262 L54,-262" stroke="#1a2238" stroke-opacity="0.55" stroke-width="2.4"/>
    <path d="M-12,-312 L8,-312 L14,-170 L2,-186 L-4,-150 L-14,-182 L-18,-160 Z" fill="#cfd6e4" opacity="0.88"/>
    <path d="M-12,-312 L8,-312 L14,-170 L2,-186 L-4,-150 L-14,-182 L-18,-160 Z" fill="none" stroke="#d9b25c" stroke-width="1.5" opacity="0.8"/>
    <!-- cuirass -->
    <path d="M-48,-440 C-58,-410 -52,-350 -34,-312 L40,-312 C46,-360 44,-420 38,-462 C20,-486 -22,-486 -48,-440 Z" fill="url(#b-plate)"/>
    <path d="M-52,-406 C-30,-396 6,-398 40,-420" stroke="#fff7d8" stroke-width="2.4" fill="none" opacity="0.8"/>
    <path d="M-36,-380 H36 M-34,-348 H36" stroke="#1a2238" stroke-opacity="0.45" stroke-width="2.2"/>
    <circle cx="-4" cy="-390" r="13" fill="url(#b-gold)" stroke="#5a3d12" stroke-width="1.5"/>
    <circle cx="-4" cy="-390" r="22" fill="url(#b-hammerglow)" style="mix-blend-mode:screen" opacity="0.8"/>
    <!-- gorget + head: helm over a gaunt, bone-pale face, profile to the left -->
    <path d="M-22,-480 L30,-480 L34,-452 L-26,-452 Z" fill="url(#b-plate2)"/>
    <path d="M-40,-496 C-42,-528 -26,-556 4,-560 C34,-560 50,-536 48,-504 L44,-482 L-24,-480 Z" fill="url(#b-plate)"/>
    <path d="M-40,-496 C-26,-488 -14,-486 -2,-492 L-8,-508 C-22,-512 -34,-508 -40,-496 Z" fill="url(#b-bone)"/>
    <path d="M-40,-496 L-30,-476 L-12,-486 L-6,-500 Z" fill="url(#b-bone)"/>
    <path d="M-30,-476 L-14,-484" stroke="#3a3a30" stroke-width="2"/>
    <ellipse cx="-24" cy="-514" rx="9" ry="5.5" fill="#1c1c20"/>
    <circle cx="-26" cy="-514" r="4.4" fill="#fff4b8"/>
    <circle cx="-26" cy="-514" r="14" fill="#ffe27a" opacity="0.6" filter="url(#b-b4)"/>
    <path d="M4,-562 C14,-576 30,-572 36,-556" stroke="url(#b-gold)" stroke-width="7" stroke-linecap="round" fill="none"/>
    <path d="M-34,-540 C-18,-556 10,-562 40,-546" stroke="#fff7d8" stroke-width="2.4" fill="none" opacity="0.85"/>
    <!-- shoulder pauldrons -->
    <path d="M-6,-486 C28,-504 64,-486 70,-450 C60,-430 30,-424 8,-436 C-8,-446 -12,-470 -6,-486 Z" fill="url(#b-plate)"/>
    <path d="M-6,-486 C28,-504 64,-486 70,-450" stroke="url(#b-gold)" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M10,-470 C34,-480 56,-468 58,-452" stroke="#1a2238" stroke-opacity="0.4" stroke-width="2" fill="none"/>
    <!-- arm holding the hammer forward -->
    <path d="M-10,-448 C-40,-432 -62,-410 -72,-392 L-60,-376 C-48,-392 -28,-408 -2,-424 Z" fill="url(#b-plate2)"/>
    <ellipse cx="-70" cy="-390" rx="15" ry="13" fill="url(#b-plate)" stroke="#3a4668" stroke-width="1.5"/>
    <!-- warhammer: haft, head, glow -->
    <path d="M-72,-250 C-70,-360 -68,-480 -66,-590" stroke="#4a3220" stroke-width="9" stroke-linecap="round"/>
    <path d="M-75,-250 C-73,-360 -71,-480 -69,-590" stroke="#e0b070" stroke-width="2" opacity="0.65"/>
    <path d="M-66,-286 H-76 M-66,-440 H-76" stroke="url(#b-gold)" stroke-width="6"/>
    <rect x="-112" y="-628" width="94" height="52" rx="7" fill="url(#b-plate)" stroke="url(#b-gold)" stroke-width="5"/>
    <path d="M-106,-622 H-24" stroke="#ffffff" stroke-width="2.2" opacity="0.75"/>
    <circle cx="-65" cy="-602" r="22" fill="url(#b-gold)" stroke="#5a3d12" stroke-width="2"/>
    <circle cx="-65" cy="-602" r="90" fill="url(#b-hammerglow)" style="mix-blend-mode:screen" opacity="0.7"/>
    <!-- rim light on the lit (left) edges -->
    <path d="M-52,-440 C-60,-410 -54,-350 -36,-312" stroke="#fff3c8" stroke-width="3" fill="none" opacity="0.85" filter="url(#b-b2)"/>
  </g>`;
}

/** Dwarven elemental mystic channelling stone and lightning. Origin = feet. */
function dwarf(x, y, s, seed) {
  const r = rng(seed);
  const defs = `
  <linearGradient id="b-dwarfcloth" gradientUnits="userSpaceOnUse" x1="-60" y1="-220" x2="70" y2="0"><stop offset="0" stop-color="#4a5f7e"/><stop offset="1" stop-color="#121a30"/></linearGradient>
  <linearGradient id="b-beard" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0a060"/><stop offset="1" stop-color="#6e3d1a"/></linearGradient>
  <linearGradient id="b-skin" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8b898"/><stop offset="1" stop-color="#8e5a46"/></linearGradient>
  <radialGradient id="b-orb"><stop offset="0" stop-color="#ffffff"/><stop offset="0.3" stop-color="#bfe6ff"/><stop offset="1" stop-color="#4aa8ff" stop-opacity="0"/></radialGradient>`;
  // floating rock fragments in a loose ring
  let rocks = "";
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.4;
    const rx = 120, ry = 46;
    const cx = Math.cos(a) * rx, cy = -150 + Math.sin(a) * ry;
    const sz = 10 + r() * 14;
    const front = Math.sin(a) > 0;
    const c = mixHex("#59627a", "#aab3c8", r());
    rocks += `<polygon points="${pts([[cx - sz, cy], [cx - sz * 0.2, cy - sz * 0.9], [cx + sz * 0.9, cy - sz * 0.3], [cx + sz * 0.6, cy + sz * 0.8], [cx - sz * 0.5, cy + sz * 0.7]])}" fill="${c}" opacity="${front ? 1 : 0.7}"/>
    <path d="M${f(cx - sz)},${f(cy)} L${f(cx - sz * 0.2)},${f(cy - sz * 0.9)} L${f(cx + sz * 0.9)},${f(cy - sz * 0.3)}" stroke="#d8f0ff" stroke-width="1.6" fill="none" opacity="0.8"/>`;
  }
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <defs>${defs}</defs>
    <ellipse cx="0" cy="3" rx="82" ry="8" fill="#02050f" opacity="0.6" filter="url(#b-b4)"/>
    <circle cx="0" cy="-330" r="110" fill="url(#b-orb)" style="mix-blend-mode:screen" opacity="0.55"/>
    <!-- legs and boots -->
    <rect x="-34" y="-70" width="28" height="70" rx="6" fill="#141b30"/><rect x="8" y="-70" width="28" height="70" rx="6" fill="#141b30"/>
    <rect x="-44" y="-16" width="40" height="16" rx="6" fill="#0a0f1e"/><rect x="6" y="-16" width="40" height="16" rx="6" fill="#0a0f1e"/>
    <!-- barrel body in a heavy robe with a fur mantle -->
    <path d="M-62,-210 C-72,-150 -66,-90 -50,-60 L52,-60 C70,-92 76,-150 64,-210 Z" fill="url(#b-dwarfcloth)"/>
    <path d="M-44,-190 L-38,-62 M-10,-196 L-8,-62 M26,-194 L28,-62" stroke="#050a18" stroke-opacity="0.4" stroke-width="3"/>
    <path d="M-52,-120 H56" stroke="#c89a50" stroke-width="7"/><rect x="-10" y="-126" width="20" height="14" rx="3" fill="#e8c070" stroke="#6a4a1c" stroke-width="1.5"/>
    <path d="M-80,-216 C-84,-250 -52,-262 0,-258 C52,-262 84,-250 80,-216 C60,-200 -60,-200 -80,-216 Z" fill="#2c3a58"/>
    <path d="M-80,-216 C-84,-250 -52,-262 0,-258 C52,-262 84,-250 80,-216" stroke="#a8c0e0" stroke-width="2.4" fill="none" opacity="0.7"/>
    <g stroke="#7088ac" stroke-width="2" opacity="0.5"><path d="M-70,-232 l8,12 M-50,-244 l8,14 M-24,-250 l8,16 M10,-252 l8,16 M38,-246 l8,14 M62,-234 l8,12"/></g>
    <!-- raised arms channelling -->
    <path d="M-66,-222 C-100,-250 -112,-296 -108,-342" stroke="#2c3a58" stroke-width="30" stroke-linecap="round" fill="none"/>
    <path d="M66,-222 C100,-250 112,-296 108,-342" stroke="#2c3a58" stroke-width="30" stroke-linecap="round" fill="none"/>
    <circle cx="-108" cy="-350" r="15" fill="url(#b-skin)"/><circle cx="108" cy="-350" r="15" fill="url(#b-skin)"/>
    <circle cx="-108" cy="-352" r="34" fill="url(#b-orb)" style="mix-blend-mode:screen"/><circle cx="108" cy="-352" r="34" fill="url(#b-orb)" style="mix-blend-mode:screen"/>
    ${rocks}
    <!-- head: round helm-cap, bushy brows, long braided beard -->
    <circle cx="0" cy="-286" r="38" fill="url(#b-skin)"/>
    <path d="M-40,-292 C-40,-332 -14,-346 4,-346 C30,-346 44,-322 40,-292 C20,-304 -22,-304 -40,-292 Z" fill="#5d6a88"/>
    <path d="M-36,-312 C-14,-338 20,-338 38,-314" stroke="#d6e6ff" stroke-width="2.4" fill="none" opacity="0.85"/>
    <path d="M-26,-290 L-6,-294 M6,-294 L26,-290" stroke="#6a3a1c" stroke-width="6" stroke-linecap="round"/>
    <circle cx="-14" cy="-284" r="3.2" fill="#1a1a1a"/><circle cx="14" cy="-284" r="3.2" fill="#1a1a1a"/>
    <path d="M-36,-280 C-52,-250 -40,-210 -16,-176 L0,-150 L16,-176 C40,-210 52,-250 36,-280 C18,-262 -18,-262 -36,-280 Z" fill="url(#b-beard)"/>
    <path d="M-20,-248 C-22,-220 -14,-196 -6,-174 M0,-250 L0,-156 M20,-248 C22,-220 14,-196 6,-174" stroke="#5a2e10" stroke-opacity="0.5" stroke-width="2.4" fill="none"/>
    <path d="M-12,-176 L-18,-136 M12,-176 L18,-136" stroke="#c88c4a" stroke-width="6" stroke-linecap="round"/><circle cx="-18" cy="-132" r="5" fill="#e8c070"/><circle cx="18" cy="-132" r="5" fill="#e8c070"/>
    <path d="M-30,-300 C-20,-318 14,-322 30,-300" stroke="#e8f4ff" stroke-width="2" fill="none" opacity="0.8"/>
  </g>`;
}

function orcCaster(x, y, s) {
  // distant silhouette: hunched, broad-shouldered, tusked, staff topped with a violet-blue spark
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <ellipse cx="0" cy="2" rx="60" ry="6" fill="#02050f" opacity="0.5" filter="url(#b-b4)"/>
    <path d="M-34,0 L-30,-70 C-52,-96 -56,-140 -34,-166 C-26,-190 -6,-196 8,-188 C26,-196 40,-176 38,-156 C58,-136 54,-90 36,-70 L32,0 Z" fill="#101a2e"/>
    <path d="M-30,-164 C-34,-180 -22,-196 -4,-198 C-8,-210 6,-214 14,-204 C28,-210 36,-192 30,-176" fill="#101a2e"/>
    <path d="M-12,-186 L-20,-172 M8,-186 L16,-172" stroke="#e0e4ea" stroke-width="2.4" opacity="0.55"/>
    <path d="M52,-20 L58,-200" stroke="#0c1424" stroke-width="5"/>
    <circle cx="58" cy="-206" r="9" fill="#bfa8ff"/><circle cx="58" cy="-206" r="26" fill="#9a86ff" opacity="0.45" filter="url(#b-b4)"/>
    <path d="M-34,-150 C-44,-160 -40,-176 -28,-176 M34,-150 C46,-158 44,-176 30,-176" stroke="#7c9ccc" stroke-width="2" fill="none" opacity="0.5"/>
  </g>`;
}

function gnomePriest(x, y, s) {
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <ellipse cx="0" cy="2" rx="22" ry="3" fill="#02050f" opacity="0.5" filter="url(#b-b2)"/>
    <path d="M-14,0 L-12,-26 C-20,-36 -16,-50 -6,-54 C-8,-66 8,-70 12,-58 C20,-50 18,-36 12,-26 L14,0 Z" fill="#141e34"/>
    <path d="M-4,-58 L0,-82 L6,-58 Z" fill="#141e34"/>
    <path d="M18,-4 L20,-76" stroke="#0e1628" stroke-width="2.4"/>
    <circle cx="20" cy="-80" r="4" fill="#fff0b8"/><circle cx="20" cy="-80" r="14" fill="#ffe27a" opacity="0.55" filter="url(#b-b2)"/>
    <path d="M-12,-30 C-6,-36 6,-36 12,-30" stroke="#ffe27a" stroke-width="1.4" fill="none" opacity="0.6"/>
  </g>`;
}

export function buildRaceClassSvg() {
  const r = rng(1104);
  const out = [];

  // ---- storm sky -------------------------------------------------------------------
  out.push(`<rect width="${W}" height="${H}" fill="url(#b-sky)"/>`);
  const C = (o) => `<g filter="url(#b-b16)">${cloudCluster(o)}</g>`;
  out.push(C({ cx: 520, cy: 130, w: 1100, h: 120, seed: 1, body: "#0f1628", lit: "#34476a", litAmt: 0.5, n: 10 }));
  out.push(C({ cx: 1500, cy: 110, w: 1100, h: 120, seed: 2, body: "#10182c", lit: "#3a4e74", litAmt: 0.55, n: 10 }));
  out.push(C({ cx: 1000, cy: 270, w: 1500, h: 90, seed: 3, body: "#1a2640", lit: "#5a739c", litAmt: 0.5, n: 11 }));
  out.push(C({ cx: 600, cy: 420, w: 1000, h: 70, seed: 4, body: "#25344f", lit: "#7e94b8", litAmt: 0.45, n: 9 }));
  out.push(C({ cx: 1500, cy: 450, w: 900, h: 60, seed: 5, body: "#2b3b58", lit: "#a8b6d0", litAmt: 0.5, n: 9 }));
  // far lightning behind the ruins + flash glow
  out.push(`<circle cx="1180" cy="300" r="620" fill="url(#b-flash)" style="mix-blend-mode:screen"/>`);
  out.push(boltSvg(bolt(1180, 150, 1120, 560, 5, 34, 16), 3.2, "#f4f9ff", "#7fb8ff"));
  out.push(boltSvg(bolt(1150, 300, 1290, 470, 9, 26, 9), 2, "#f4f9ff", "#7fb8ff"));
  out.push(boltSvg(bolt(1120, 420, 1020, 580, 12, 20, 8), 1.6, "#f4f9ff", "#7fb8ff"));

  // ---- far hills + ruined skyline --------------------------------------------------
  const far = [[160, 760, 220, 380, 340], [620, 760, 280, 380, 400], [1480, 760, 330, 420, 420], [1840, 760, 280, 360, 360]];
  far.forEach(([cx, by, h, wl, wr], i) => out.push(`<g filter="url(#b-wobble)">${peak({ cx, by, h, wl, wr, seed: 300 + i, litSide: cx < 1180 ? 1 : -1, rock: "#1f2b44", rockShade: "#131b30", snow: "#4a5d82", snowShade: "#2a3858", snowDepth: 0.2 })}</g>`));
  out.push(`<rect y="480" width="${W}" height="300" fill="url(#b-mist)" style="mix-blend-mode:screen" opacity="0.55"/>`);
  // distant broken towers
  const tower = (x, base, w, h, c) => `<polygon points="${pts([[x - w / 2, base], [x - w / 2, base - h], [x - w * 0.2, base - h - 14], [x, base - h + 6], [x + w * 0.3, base - h - 20], [x + w / 2, base - h - 4], [x + w / 2, base]])}" fill="${c}"/>`;
  out.push(tower(820, 760, 70, 230, "#243350"), tower(900, 760, 46, 150, "#222f4a"), tower(1400, 760, 84, 270, "#243350"), tower(1330, 760, 50, 160, "#222f4a"));
  out.push(`<rect y="560" width="${W}" height="240" fill="url(#b-mist)" style="mix-blend-mode:screen" opacity="0.6"/>`);

  // ruined arches + columns (mid distance)
  out.push(`<g opacity="0.95">${archRuin(1030, 800, 300, 260, "#2c3b58", "#18233b", 4)}${column(700, 800, 190, 36, "#2a3854", "#18233b", 1)}${column(1240, 800, 220, 40, "#2a3854", "#18233b", 0)}${column(1330, 800, 120, 36, "#2a3854", "#18233b", 1)}</g>`);
  out.push(banner(1240, 470, 190, 90, "#2f4668", "#c9a255", 3, 1));
  out.push(banner(700, 560, 150, 70, "#2a3c5c", "#b98f4c", 5, 1));
  out.push(`<rect y="640" width="${W}" height="200" fill="url(#b-mist)" style="mix-blend-mode:screen" opacity="0.5"/>`);

  // ---- ground: wet flagstones + puddles --------------------------------------------
  out.push(`<polygon points="-20,790 ${W + 20},790 ${W + 20},${H + 20} -20,${H + 20}" fill="url(#b-ground)"/>`);
  // perspective joints
  let joints = "";
  for (let i = 0; i < 14; i++) {
    const y = 790 + Math.pow(i / 14, 1.7) * 300;
    joints += `<line x1="-20" y1="${f(y)}" x2="${W + 20}" y2="${f(y)}" stroke="#05091a" stroke-opacity="${f(0.25 + i * 0.02)}" stroke-width="${f(1 + i * 0.35)}"/>`;
  }
  for (let i = -16; i <= 16; i++) joints += `<line x1="${f(960 + i * 30)}" y1="790" x2="${f(960 + i * 220)}" y2="${H + 20}" stroke="#05091a" stroke-opacity="0.18" stroke-width="1.6"/>`;
  out.push(`<g>${joints}</g>`);
  // puddles mirroring the flash
  out.push(`<ellipse cx="1000" cy="900" rx="320" ry="30" fill="url(#b-puddle)" style="mix-blend-mode:screen"/><ellipse cx="1300" cy="990" rx="250" ry="24" fill="url(#b-puddle)" style="mix-blend-mode:screen" opacity="0.8"/><ellipse cx="760" cy="850" rx="170" ry="14" fill="url(#b-puddle)" style="mix-blend-mode:screen" opacity="0.6"/>`);
  out.push(`<rect y="780" width="${W}" height="60" fill="url(#b-mist)" style="mix-blend-mode:screen" opacity="0.55"/>`);

  // ---- distant casters (orc + gnome) -----------------------------------------------
  out.push(`<g opacity="0.82">${orcCaster(740, 840, 1.0)}</g>`);
  out.push(`<g opacity="0.88">${gnomePriest(962, 858, 1.05)}</g>`);

  // ---- dwarf shaman (mid-ground) with lightning ------------------------------------
  const dx = 1190, dy = 905, ds = 0.82;
  // bolts from his hands up into the storm and arcing between hands
  out.push(boltSvg(bolt(dx - 108 * ds, dy - 358 * ds, dx - 150, 470, 21, 26, 11), 2.2, "#ffffff", "#7fc8ff"));
  out.push(boltSvg(bolt(dx + 108 * ds, dy - 358 * ds, dx + 170, 490, 22, 26, 11), 2.2, "#ffffff", "#7fc8ff"));
  out.push(boltSvg(bolt(dx - 108 * ds, dy - 356 * ds, dx + 108 * ds, dy - 356 * ds, 23, 14, 9), 2.2, "#ffffff", "#7fc8ff"));
  out.push(dwarf(dx, dy, ds, 17));
  // splash of stone and sparks on the ground
  let sparks = "";
  for (let i = 0; i < 38; i++) sparks += `<circle cx="${f(dx - 160 + r() * 320)}" cy="${f(dy - 380 + r() * 380)}" r="${f(0.8 + r() * 2)}" fill="#cfeaff" opacity="${f(0.3 + r() * 0.6)}"/>`;
  out.push(`<g style="mix-blend-mode:screen">${sparks}</g>`);

  // ---- foreground: broken wall (right) and rubble ----------------------------------
  const wall = [[1700, 1100], [1700, 780], [1740, 770], [1760, 740], [1820, 748], [1850, 700], [1920, 704], [1980, 700], [1980, 1100]];
  out.push(`<polygon points="${pts(wall)}" fill="url(#b-wallfg)" filter="url(#b-wobble)"/>`);
  const br = rng(55);
  let bricks = "";
  for (let i = 0; i < 7; i++) bricks += `<path d="M1700,${f(800 + i * 44)} L1980,${f(790 + i * 44)}" stroke="#02050f" stroke-opacity="0.35" stroke-width="2"/>`;
  out.push(bricks);
  let rubble = "";
  for (let i = 0; i < 16; i++) {
    const rx = 1180 + br() * 760, ry = 1010 + br() * 70, sz = 16 + br() * 40;
    rubble += `<polygon points="${pts([[rx - sz, ry], [rx - sz * 0.3, ry - sz * 0.7], [rx + sz * 0.8, ry - sz * 0.4], [rx + sz, ry + sz * 0.3], [rx - sz * 0.5, ry + sz * 0.4]])}" fill="${mixHex("#0a1020", "#2a3858", br())}"/>`;
  }
  out.push(rubble);
  out.push(`<polygon points="-20,${H + 20} -20,880 140,900 300,990 520,1060 700,${H + 20}" fill="#04070f" opacity="0.85"/>`);

  // ---- undead paladin (main subject, right third) ----------------------------------
  out.push(paladin(1540, 1030, 1.32));

  // ---- atmosphere: rain, motes of holy light, vignette, grade ----------------------
  let rain = "";
  for (let i = 0; i < 260; i++) {
    const rx = r() * (W + 400) - 200, ry = r() * H, len = 30 + r() * 60;
    rain += `<line x1="${f(rx)}" y1="${f(ry)}" x2="${f(rx - len * 0.28)}" y2="${f(ry + len)}" stroke="#bcd0f0" stroke-opacity="${f(0.05 + r() * 0.13)}" stroke-width="${f(0.8 + r() * 1.1)}"/>`;
  }
  out.push(`<g>${rain}</g>`);
  let motes = "";
  for (let i = 0; i < 60; i++) {
    const a = r() * Math.PI * 2, rr = 80 + r() * 330;
    motes += `<circle cx="${f(1520 + Math.cos(a) * rr * 0.9)}" cy="${f(760 + Math.sin(a) * rr * 1.0)}" r="${f(0.9 + r() * 2.4)}" fill="#ffeaa0" opacity="${f(0.25 + r() * 0.6)}"/>`;
  }
  out.push(`<g style="mix-blend-mode:screen">${motes}</g>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#b-warm)" style="mix-blend-mode:soft-light"/>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#b-vignette)"/>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#b-leftdark)"/>`);
  out.push(`<rect width="${W}" height="${H}" filter="url(#b-grain)" opacity="0.2" style="mix-blend-mode:overlay"/>`);

  const defs = `
  ${commonDefs("b")}
  <linearGradient id="b-sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#070b18"/><stop offset="0.3" stop-color="#141d34"/><stop offset="0.55" stop-color="#2b3b5a"/><stop offset="0.72" stop-color="#52698f"/><stop offset="1" stop-color="#52698f"/>
  </linearGradient>
  <radialGradient id="b-flash"><stop offset="0" stop-color="#e8f2ff" stop-opacity="0.8"/><stop offset="0.3" stop-color="#8fb4ee" stop-opacity="0.35"/><stop offset="1" stop-color="#8fb4ee" stop-opacity="0"/></radialGradient>
  <linearGradient id="b-mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fb8e0" stop-opacity="0"/><stop offset="0.55" stop-color="#9fb8e0" stop-opacity="0.35"/><stop offset="1" stop-color="#9fb8e0" stop-opacity="0"/></linearGradient>
  <linearGradient id="b-ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34445f"/><stop offset="0.35" stop-color="#1b2740"/><stop offset="1" stop-color="#070b18"/></linearGradient>
  <radialGradient id="b-puddle"><stop offset="0" stop-color="#cfe2ff" stop-opacity="0.75"/><stop offset="0.6" stop-color="#7fa2dc" stop-opacity="0.25"/><stop offset="1" stop-color="#7fa2dc" stop-opacity="0"/></radialGradient>
  <linearGradient id="b-wallfg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#26324d"/><stop offset="1" stop-color="#070b18"/></linearGradient>
  <radialGradient id="b-warm" cx="0.8" cy="0.6" r="0.5"><stop offset="0" stop-color="#ffd27a" stop-opacity="0.22"/><stop offset="1" stop-color="#ffd27a" stop-opacity="0"/></radialGradient>
  <radialGradient id="b-vignette" cx="0.6" cy="0.55" r="0.78"><stop offset="0.5" stop-color="#03050e" stop-opacity="0"/><stop offset="1" stop-color="#03050e" stop-opacity="0.5"/></radialGradient>
  <linearGradient id="b-leftdark" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#03050e" stop-opacity="0.5"/><stop offset="0.35" stop-color="#03050e" stop-opacity="0.26"/><stop offset="0.6" stop-color="#03050e" stop-opacity="0"/></linearGradient>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${out.join("\n")}</svg>`;
}
