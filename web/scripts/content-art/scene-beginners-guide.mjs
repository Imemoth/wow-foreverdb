// Illustration A: "The First Road Into Azeroth" - original AzerDex editorial artwork.
// Procedural, deterministic SVG (1920x1080). No text, logos, UI or third-party art.
import { rng, f, pts, mix, mixHex, ridgeLine, ridgePath, pine, sampleBezier, commonDefs, peak, cloudCluster } from "./lib.mjs";

const W = 1920, H = 1080;
const SUN = { x: 1010, y: 600 };

const haze = "#e9a56a";

/** Pines scattered along a ridge line, drawn back-to-front. */
function forest(line, { seed, density, hMin, hMax, drop, fill, shade, tint, tintAmt, from = -20, to = W + 20 }) {
  const r = rng(seed);
  const at = (x) => {
    for (let i = 0; i < line.length - 1; i++) {
      if (x >= line[i][0] && x <= line[i + 1][0]) {
        const t = (x - line[i][0]) / (line[i + 1][0] - line[i][0]);
        return mix(line[i][1], line[i + 1][1], t);
      }
    }
    return line[line.length - 1][1];
  };
  const trees = [];
  for (let x = from; x < to; x += density) {
    const xx = x + (r() - 0.5) * density;
    trees.push({ x: xx, y: at(xx) + r() * drop, h: mix(hMin, hMax, r()), k: r() });
  }
  trees.sort((a, b) => a.y - b.y);
  return trees
    .map((t) => pine(t.x, t.y + t.h * 0.1, t.h, mixHex(mixHex(fill, tint, tintAmt), "#000000", t.k * 0.12), mixHex(mixHex(shade, tint, tintAmt), "#000000", t.k * 0.1)))
    .join("");
}

function castle(x, y, s, body, roof, lit) {
  const u = (n) => n * s;
  const win = (wx, wy) => `<rect x="${f(x + u(wx))}" y="${f(y - u(wy))}" width="${f(u(3))}" height="${f(u(6))}" fill="#ffd28a" opacity="${lit}"/>`;
  const tower = (cx, w, h, rh) => {
    let t = `<rect x="${f(x + u(cx - w / 2))}" y="${f(y - u(h))}" width="${f(u(w))}" height="${f(u(h))}" fill="${body}"/>`;
    // crenellation
    const n = Math.max(3, Math.round(w / 6));
    for (let i = 0; i < n; i++) t += `<rect x="${f(x + u(cx - w / 2 + (i * w) / n))}" y="${f(y - u(h + 4))}" width="${f(u(w / n / 1.8))}" height="${f(u(4))}" fill="${body}"/>`;
    // conical roof
    t += `<polygon points="${f(x + u(cx))},${f(y - u(h + 4 + rh))} ${f(x + u(cx + w / 2 + 3))},${f(y - u(h))} ${f(x + u(cx - w / 2 - 3))},${f(y - u(h))}" fill="${roof}"/>`;
    t += `<polygon points="${f(x + u(cx))},${f(y - u(h + 4 + rh))} ${f(x + u(cx + w / 2 + 3))},${f(y - u(h))} ${f(x + u(cx + 1))},${f(y - u(h))}" fill="#000" opacity="0.28"/>`;
    t += `<rect x="${f(x + u(cx + w * 0.12))}" y="${f(y - u(h))}" width="${f(u(w * 0.38))}" height="${f(u(h))}" fill="#000" opacity="0.2"/>`;
    return t;
  };
  let g = "";
  g += `<rect x="${f(x - u(60))}" y="${f(y - u(34))}" width="${f(u(126))}" height="${f(u(34))}" fill="${body}"/>`;
  for (let i = 0; i < 14; i++) g += `<rect x="${f(x - u(60) + u(i * 9))}" y="${f(y - u(38))}" width="${f(u(5))}" height="${f(u(5))}" fill="${body}"/>`;
  g += tower(-48, 22, 76, 26);
  g += tower(-6, 30, 118, 40);
  g += tower(40, 20, 64, 22);
  g += tower(62, 14, 50, 18);
  g += win(-10, 90) + win(0, 66) + win(-50, 50) + win(38, 42) + win(-30, 22) + win(10, 22);
  // arched gate
  g += `<path d="M${f(x + u(14))},${f(y)} v${f(-u(18))} a${f(u(7))},${f(u(7))} 0 0 1 ${f(u(14))},0 v${f(u(18))} Z" fill="#000" opacity="0.5"/>`;
  return g;
}

function tinyTower(x, y, s, body, roof) {
  const u = (n) => n * s;
  return `<rect x="${f(x - u(8))}" y="${f(y - u(60))}" width="${f(u(16))}" height="${f(u(60))}" fill="${body}"/>
  <polygon points="${f(x)},${f(y - u(86))} ${f(x + u(11))},${f(y - u(60))} ${f(x - u(11))},${f(y - u(60))}" fill="${roof}"/>
  <rect x="${f(x - u(1.6))}" y="${f(y - u(44))}" width="${f(u(3.2))}" height="${f(u(7))}" fill="#ffd28a" opacity="0.7"/>`;
}

function figure(x, y, s) {
  const defs = `<linearGradient id="a-rim" gradientUnits="userSpaceOnUse" x1="-110" y1="0" x2="96" y2="0">
      <stop offset="0" stop-color="#ffe0a0" stop-opacity="1"/><stop offset="0.5" stop-color="#ffb870" stop-opacity="0.4"/><stop offset="1" stop-color="#ffb870" stop-opacity="0"/></linearGradient>
    <linearGradient id="a-cloak" gradientUnits="userSpaceOnUse" x1="-90" y1="-340" x2="90" y2="-10">
      <stop offset="0" stop-color="#3d5f78"/><stop offset="0.4" stop-color="#1f3350"/><stop offset="1" stop-color="#0b1226"/></linearGradient>
    <linearGradient id="a-cloak2" gradientUnits="userSpaceOnUse" x1="-150" y1="-250" x2="-80" y2="-10">
      <stop offset="0" stop-color="#456a80" stop-opacity="0.95"/><stop offset="1" stop-color="#17263f" stop-opacity="0.9"/></linearGradient>
    <linearGradient id="a-leather" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a5c34"/><stop offset="1" stop-color="#3a2514"/></linearGradient>`;
  // Slim travelling cloak: narrow shoulders, waist, then a wind-swept flare to a ragged hem.
  const body = "M-24,-322 C-44,-316 -56,-296 -60,-262 C-66,-214 -60,-170 -66,-120 C-72,-76 -86,-40 -98,-8 L-84,-2 L-72,-11 L-58,-1 L-42,-9 L-26,0 L-8,-7 L10,0 L28,-9 L46,0 L62,-8 L78,-1 L92,-6 C80,-46 70,-80 64,-126 C58,-172 62,-214 56,-262 C52,-296 40,-316 24,-322 Z";
  const flap = "M-56,-282 C-82,-270 -104,-246 -116,-214 C-110,-160 -108,-100 -102,-48 L-92,-8 C-80,-40 -72,-76 -66,-120 C-60,-170 -62,-214 -60,-262 Z";
  const hood = "M-28,-318 C-38,-346 -30,-382 -2,-394 C14,-398 34,-384 34,-352 C34,-338 31,-326 27,-318 C10,-309 -10,-309 -28,-318 Z";
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <defs>${defs}</defs>
    <ellipse cx="-6" cy="3" rx="120" ry="9" fill="#050816" opacity="0.6" filter="url(#a-b4)"/>
    <path d="${flap}" fill="url(#a-cloak2)" filter="url(#a-wobble)"/>
    <path d="M-120,-196 C-112,-140 -108,-90 -100,-30" stroke="#07102a" stroke-opacity="0.4" stroke-width="3" fill="none"/>
    <path d="${body}" fill="url(#a-cloak)" filter="url(#a-wobble)"/>
    <path d="M-34,-250 C-40,-170 -38,-90 -50,-14 M-6,-270 C-8,-170 -4,-90 -10,-10 M24,-260 C26,-170 30,-90 34,-8 M50,-230 C52,-160 60,-80 72,-12" stroke="#050a18" stroke-opacity="0.38" stroke-width="3" fill="none"/>
    <path d="M-60,-262 C-30,-250 0,-246 56,-262" stroke="#06091a" stroke-opacity="0.45" stroke-width="3" fill="none"/>
    <rect x="-46" y="-304" width="92" height="22" rx="11" fill="url(#a-leather)"/>
    <rect x="-33" y="-290" width="66" height="104" rx="14" fill="#47301e"/>
    <rect x="-33" y="-290" width="66" height="104" rx="14" fill="none" stroke="#d3a566" stroke-width="1.6" stroke-opacity="0.55"/>
    <path d="M-33,-262 H33 M-33,-224 H33" stroke="#8a6338" stroke-width="3"/>
    <path d="M-28,-294 C-25,-250 -25,-215 -22,-186 M28,-294 C25,-250 25,-215 22,-186" stroke="#d3a566" stroke-opacity="0.35" stroke-width="2" fill="none"/>
    <path d="${hood}" fill="#2a4560"/>
    <path d="M16,-396 C30,-378 32,-350 24,-324" stroke="#05091a" stroke-opacity="0.5" stroke-width="6" fill="none"/>
    <path d="${hood}" fill="none" stroke="url(#a-rim)" stroke-width="3.4" filter="url(#a-b2)"/>
    <path d="${hood}" fill="none" stroke="url(#a-rim)" stroke-width="2"/>
    <path d="${body}" fill="none" stroke="url(#a-rim)" stroke-width="2.8"/>
    <path d="${flap}" fill="none" stroke="url(#a-rim)" stroke-width="2.2" opacity="0.8"/>
    <!-- staff -->
    <path d="M88,-440 C94,-300 90,-120 92,4" stroke="#3b2816" stroke-width="8" stroke-linecap="round" fill="none"/>
    <path d="M85,-440 C87,-300 84,-120 86,4" stroke="#e0b070" stroke-width="2" stroke-opacity="0.6" fill="none"/>
    <circle cx="88" cy="-428" r="10" fill="none" stroke="#d9b978" stroke-width="3"/>
    <circle cx="88" cy="-428" r="4.2" fill="#fff0c0"/>
    <circle cx="88" cy="-428" r="26" fill="#ffd58f" opacity="0.28" filter="url(#a-b8)"/>
    <ellipse cx="-24" cy="-2" rx="24" ry="8" fill="#0a0e1c"/><ellipse cx="30" cy="-2" rx="24" ry="8" fill="#0a0e1c"/>
  </g>`;
}

function props() {
  // Shield, bow, quiver, spellbook on the ledge to the left of the traveller.
  const shield = `<g transform="translate(1176 948) rotate(-9)">
      <defs>
        <linearGradient id="a-steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8d9ab0"/><stop offset="0.5" stop-color="#4b566e"/><stop offset="1" stop-color="#232b40"/></linearGradient>
        <linearGradient id="a-brass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f0d08c"/><stop offset="1" stop-color="#8a6330"/></linearGradient>
      </defs>
      <path d="M-62,-170 H62 V-60 C62,-14 26,12 0,26 C-26,12 -62,-14 -62,-60 Z" fill="url(#a-steel)" stroke="url(#a-brass)" stroke-width="7" stroke-linejoin="round"/>
      <path d="M0,-170 V26" stroke="#1a2236" stroke-width="3" opacity="0.6"/>
      <path d="M-62,-110 H62" stroke="#1a2236" stroke-width="3" opacity="0.45"/>
      <path d="M-50,-150 L-18,-140 M20,-92 L44,-110 M-44,-60 L-26,-44" stroke="#c9d3e6" stroke-width="1.8" opacity="0.5"/>
      <circle cx="0" cy="-96" r="17" fill="url(#a-brass)" stroke="#5a3d1c" stroke-width="2"/>
      <circle cx="-4" cy="-100" r="5" fill="#fff0c4" opacity="0.65"/>
      <path d="M-62,-170 H62" stroke="#ffe3a8" stroke-width="2.4" opacity="0.8"/>
      <path d="M-62,-170 V-60" stroke="#ffcf8a" stroke-width="2" opacity="0.7"/>
    </g>`;
  const bow = `<g transform="translate(1396 956) rotate(6)">
      <path d="M-4,-176 C-58,-110 -58,-58 -4,6" stroke="#5a3a1e" stroke-width="8" fill="none" stroke-linecap="round"/>
      <path d="M-4,-176 C-52,-110 -52,-58 -4,6" stroke="#d3a566" stroke-width="1.8" fill="none" opacity="0.7"/>
      <path d="M-4,-176 L-4,6" stroke="#e8dcc0" stroke-width="1.4" opacity="0.8"/>
      <path d="M-56,-96 v22" stroke="#2b1b0e" stroke-width="10" stroke-linecap="round"/>
    </g>`;
  const quiver = `<g transform="translate(1448 956) rotate(10)">
      <path d="M-13,-96 L13,-96 L11,0 L-11,0 Z" fill="#5b3b20"/>
      <path d="M13,-96 L11,0 L2,0 L5,-96 Z" fill="#000" opacity="0.3"/>
      <path d="M-13,-80 H12 M-12,-34 H11" stroke="#b78a50" stroke-width="2.4"/>
      <g stroke="#3a2a1b" stroke-width="2"><path d="M-6,-96 L-8,-124"/><path d="M0,-96 L1,-130"/><path d="M6,-96 L9,-122"/></g>
      <path d="M-8,-124 l-5,-9 l9,3z M1,-130 l-4,-10 l9,4z M9,-122 l-4,-10 l9,4z" fill="#d8dcea" opacity="0.85"/>
      <path d="M-13,-96 L-11,0" stroke="#ffcf8a" stroke-width="2" opacity="0.75"/>
    </g>`;
  const book = `<g transform="translate(1296 958)">
      <defs>
        <radialGradient id="a-bookglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#cdbbff" stop-opacity="0.95"/><stop offset="0.35" stop-color="#8f7dff" stop-opacity="0.45"/><stop offset="1" stop-color="#6c41c7" stop-opacity="0"/></radialGradient>
        <linearGradient id="a-beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#cdbbff" stop-opacity="0.55"/><stop offset="1" stop-color="#cdbbff" stop-opacity="0"/></linearGradient>
        <linearGradient id="a-cover" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a2a66"/><stop offset="1" stop-color="#1a1236"/></linearGradient>
      </defs>
      <ellipse cx="0" cy="-26" rx="150" ry="110" fill="url(#a-bookglow)" opacity="0.8" style="mix-blend-mode:screen"/>
      <polygon points="-34,-6 34,-6 46,-150 -46,-150" fill="url(#a-beam)" filter="url(#a-b8)"/>
      <!-- flat stone -->
      <path d="M-86,6 L-70,-12 L70,-14 L92,6 Z" fill="#3b4258"/>
      <path d="M-70,-12 L70,-14" stroke="#ffd08c" stroke-width="2" opacity="0.7"/>
      <!-- open book -->
      <path d="M-64,-14 L-4,-8 L-4,-42 L-58,-50 Z" fill="url(#a-cover)" stroke="#d9b978" stroke-width="1.6"/>
      <path d="M64,-14 L4,-8 L4,-42 L58,-50 Z" fill="url(#a-cover)" stroke="#d9b978" stroke-width="1.6"/>
      <path d="M-58,-18 L-6,-13 L-6,-40 L-53,-46 Z" fill="#efe3c4"/>
      <path d="M58,-18 L6,-13 L6,-40 L53,-46 Z" fill="#e6d7b2"/>
      <g stroke="#7a6a8f" stroke-width="1.3" opacity="0.7"><path d="M-50,-24 L-12,-20 M-50,-30 L-12,-26 M-50,-36 L-12,-32 M50,-24 L12,-20 M50,-30 L12,-26 M50,-36 L12,-32"/></g>
      <circle cx="0" cy="-34" r="26" fill="url(#a-bookglow)" style="mix-blend-mode:screen"/>
      <g fill="#e9dcff" opacity="0.9">
        <circle cx="-14" cy="-84" r="2.4"/><circle cx="18" cy="-112" r="1.8"/><circle cx="-4" cy="-136" r="2.2"/><circle cx="30" cy="-70" r="1.6"/><circle cx="-34" cy="-110" r="1.5"/>
      </g>
    </g>`;
  return shield + bow + quiver + book;
}

export function buildBeginnersGuideSvg() {
  const r = rng(404);
  const out = [];

  // ---- sky --------------------------------------------------------------------------
  out.push(`<rect width="${W}" height="${H}" fill="url(#a-sky)"/>`);
  let stars = "";
  for (let i = 0; i < 110; i++) stars += `<circle cx="${f(r() * W)}" cy="${f(r() * 260)}" r="${f(0.5 + r() * 1.1)}" fill="#dfe4ff" opacity="${f(0.12 + r() * 0.45 * (1 - (r() * 0.4)))}"/>`;
  out.push(stars);
  out.push(`<circle cx="${SUN.x}" cy="${SUN.y}" r="760" fill="url(#a-sunglow)" style="mix-blend-mode:screen"/>`);
  // clouds: high violet, mid mauve, low gold-lit banks around the sun
  const C = (o) => `<g filter="url(#a-b8)">${cloudCluster(o)}</g>`;
  out.push(C({ cx: 420, cy: 170, w: 640, h: 70, seed: 1, body: "#3c3a82", lit: "#8a63a8", litAmt: 0.5 }));
  out.push(C({ cx: 1480, cy: 150, w: 720, h: 76, seed: 2, body: "#3a3a84", lit: "#a870a6", litAmt: 0.55 }));
  out.push(C({ cx: 820, cy: 300, w: 760, h: 70, seed: 3, body: "#5a4a92", lit: "#e08a86", litAmt: 0.6 }));
  out.push(C({ cx: 1560, cy: 330, w: 640, h: 60, seed: 4, body: "#6a5090", lit: "#f09a78", litAmt: 0.7 }));
  out.push(C({ cx: 300, cy: 400, w: 560, h: 52, seed: 5, body: "#7a5a90", lit: "#f0a47a", litAmt: 0.65 }));
  out.push(C({ cx: 1180, cy: 440, w: 760, h: 46, seed: 6, body: "#a06a8e", lit: "#ffc486", litAmt: 0.85 }));
  out.push(C({ cx: 700, cy: 480, w: 620, h: 36, seed: 7, body: "#b8728a", lit: "#ffcf92", litAmt: 0.85 }));
  out.push(`<circle cx="${SUN.x}" cy="${SUN.y}" r="54" fill="#fff8de"/><circle cx="${SUN.x}" cy="${SUN.y}" r="150" fill="url(#a-sunglow2)" style="mix-blend-mode:screen"/>`);

  // ---- far snow peaks ---------------------------------------------------------------
  const far = [
    // cx, base, height, wl, wr
    [90, 760, 390, 390, 330], [420, 760, 450, 360, 360], [740, 760, 360, 310, 320],
    [1290, 760, 420, 340, 330], [1560, 760, 550, 360, 340], [1840, 760, 460, 340, 380],
  ];
  far.forEach(([cx, by, h, wl, wr], i) => {
    const litSide = cx < SUN.x ? 1 : -1;
    out.push(`<g filter="url(#a-wobble)">${peak({ cx, by, h, wl, wr, seed: 100 + i, litSide, rock: "#5a5f9c", rockShade: "#3e437f", snow: "#fff1de", snowShade: "#c4bde0", snowDepth: 0.36 })}</g>`);
  });
  out.push(`<rect y="500" width="${W}" height="220" fill="url(#a-horizonhaze)" style="mix-blend-mode:screen"/>`);
  const near = [
    [-60, 790, 280, 300, 280], [260, 790, 250, 290, 280], [560, 790, 230, 280, 290],
    [1480, 790, 290, 300, 280], [1760, 790, 270, 320, 300],
  ];
  near.forEach(([cx, by, h, wl, wr], i) => {
    const litSide = cx < SUN.x ? 1 : -1;
    out.push(`<g filter="url(#a-wobble)">${peak({ cx, by, h, wl, wr, seed: 200 + i, litSide, rock: "#4a4d88", rockShade: "#343871", snow: "#f6dfd6", snowShade: "#b3a9d0", snowDepth: 0.26 })}</g>`);
  });
  out.push(`<rect y="560" width="${W}" height="190" fill="url(#a-horizonhaze)" style="mix-blend-mode:screen" opacity="0.7"/>`);

  // ---- valleys with forests ---------------------------------------------------------
  const h1 = ridgeLine({ y: 712, amp: 70, rough: 0.52, seed: 5 });
  out.push(`<path d="${ridgePath(h1)}" fill="#4a5588" filter="url(#a-paint)"/>`);
  out.push(forest(h1, { seed: 31, density: 11, hMin: 26, hMax: 44, drop: 18, fill: "#3b5870", shade: "#2a4062", tint: haze, tintAmt: 0.2 }));
  out.push(tinyTower(1330, 722, 0.8, "#59638f", "#7a5a78"));
  out.push(`<rect y="650" width="${W}" height="150" fill="url(#a-fog)" opacity="0.9"/>`);

  const h2 = ridgeLine({ y: 780, amp: 90, rough: 0.5, seed: 9, bias: (x) => -Math.max(0, 70 - Math.abs(x - 560) * 0.28) });
  out.push(`<path d="${ridgePath(h2)}" fill="#33416b" filter="url(#a-paint)"/>`);
  out.push(castle(560, 750, 1.0, "#575c8e", "#66507a", 0.85));
  out.push(forest(h2, { seed: 77, density: 10, hMin: 36, hMax: 64, drop: 36, fill: "#2a4b60", shade: "#1d3350", tint: haze, tintAmt: 0.1 }));
  out.push(`<rect y="730" width="${W}" height="150" fill="url(#a-fog)" opacity="0.75"/>`);

  // thin distant roads: one winding down from the castle gate, one leading toward the sunrise gap
  const thinRoad = (segs, w0, w1, c0, c1, op) => {
    const rp = sampleBezier(segs, 16);
    let g = "";
    for (let i = 0; i < rp.length - 1; i++) {
      const t = i / (rp.length - 1);
      g += `<path d="M${f(rp[i][0])},${f(rp[i][1])} L${f(rp[i + 1][0])},${f(rp[i + 1][1])}" stroke="${mixHex(c0, c1, t)}" stroke-width="${f(mix(w0, w1, t))}" stroke-linecap="round" fill="none"/>`;
    }
    return `<g opacity="${op}">${g}</g>`;
  };
  out.push(thinRoad([[[1011, 722], [1000, 740], [1030, 752], [1000, 768]], [[1000, 768], [960, 788], [1050, 800], [990, 826]], [[990, 826], [930, 850], [1060, 870], [980, 900]]], 2, 14, "#ffe9b8", "#d9b88a", 0.85));
  out.push(thinRoad([[[592, 754], [610, 770], [560, 782], [610, 796]], [[610, 796], [660, 812], [560, 830], [640, 850]], [[640, 850], [700, 866], [620, 890], [700, 910]]], 3, 12, "#e8cfa0", "#b79a78", 0.7));
  const h3 = ridgeLine({ y: 850, amp: 80, rough: 0.5, seed: 12 });
  out.push(`<path d="${ridgePath(h3)}" fill="#1f2d52" filter="url(#a-paint)"/>`);
  out.push(forest(h3, { seed: 91, density: 9, hMin: 56, hMax: 104, drop: 70, fill: "#21424f", shade: "#142639", tint: "#e0905e", tintAmt: 0.05 }));
  out.push(`<rect y="800" width="${W}" height="200" fill="url(#a-fog2)" opacity="0.9"/>`);
  // ---- foreground: slope, ledge, framing pines -------------------------------------
  const lr = rng(88);
  out.push(`<path d="M-20,1100 L-20,940 C120,956 300,984 480,1004 C640,1022 760,1012 860,1004 L900,1100 Z" fill="url(#a-ground)"/>`);
  out.push(forest(ridgeLine({ x0: -60, x1: 2000, y: 1010, amp: 30, seed: 3 }), { seed: 5, from: -60, to: 330, density: 46, hMin: 300, hMax: 560, drop: 40, fill: "#0b1429", shade: "#070d1d", tint: "#0b1429", tintAmt: 0 }));
  const top = [[560, 1100], [640, 1064], [720, 1030], [800, 1004], [880, 982], [960, 974], [1040, 968], [1120, 964], [1200, 960], [1280, 956], [1360, 952], [1440, 934], [1520, 926], [1600, 908], [1680, 882], [1750, 854], [1830, 838], [1920, 816], [1980, 796], [1980, 1100]];
  const ledge = top.map(([x, y], i) => [x, y + (i > 1 && i < top.length - 3 ? (lr() - 0.5) * 14 : 0)]);
  out.push(`<defs><clipPath id="a-clip-ledge"><polygon points="${pts(ledge)}"/></clipPath></defs>`);
  out.push(`<polygon points="${pts(ledge)}" fill="url(#a-rock)"/>`);
  // chunky strata slabs: solid planes with a lit top edge, all sheared to match the ledge slope
  let facets = "";
  for (let i = 0; i < 34; i++) {
    const fx = 820 + lr() * 1160, fy = 985 + lr() * 100, fw = 60 + lr() * 170, fh = 14 + lr() * 34;
    const sh = -fw * 0.1;
    const c = mixHex("#1c2442", "#3a446c", lr());
    facets += `<polygon points="${pts([[fx, fy], [fx + fw, fy + sh], [fx + fw * 0.94, fy + sh + fh], [fx + fw * 0.05, fy + fh]])}" fill="${c}" opacity="0.9"/>`;
    facets += `<path d="M${f(fx)},${f(fy)} L${f(fx + fw)},${f(fy + sh)}" stroke="#ffcf8a" stroke-width="1.6" opacity="${f(0.15 + lr() * 0.3)}"/>`;
  }
  out.push(`<g clip-path="url(#a-clip-ledge)">${facets}</g>`);
  out.push(`<polyline points="${pts(ledge.slice(1, -2))}" fill="none" stroke="#ffd58f" stroke-width="3.4" opacity="0.7" filter="url(#a-b2)"/>`);
  let strata = "";
  for (let i = 0; i < 24; i++) {
    const sx = 840 + lr() * 1080, sy = 995 + lr() * 85;
    strata += `<path d="M${f(sx)},${f(sy)} l${f(30 + lr() * 90)},${f((lr() - 0.5) * 12)}" stroke="#05081a" stroke-opacity="${f(0.2 + lr() * 0.25)}" stroke-width="${f(1 + lr() * 2)}"/>`;
  }
  out.push(strata);
  let grass = "";
  for (let x = 900; x < 1920; x += 14 + lr() * 12) {
    const seg = ledge.find((p, i) => ledge[i + 1] && x >= p[0] && x < ledge[i + 1][0]);
    if (!seg) continue;
    const gy = seg[1] + 2;
    for (let k = 0; k < 3; k++) grass += `<path d="M${f(x + k * 3)},${f(gy)} q${f(-2 + k * 2)},${f(-12 - lr() * 12)} ${f(4 + k)},${f(-18 - lr() * 12)}" stroke="#4a8a5e" stroke-width="1.8" fill="none" opacity="0.75"/>`;
  }
  out.push(grass);

  // ---- props + traveller -----------------------------------------------------------
  out.push(props());
  out.push(figure(1612, 912, 1.1));

  // ---- atmosphere ------------------------------------------------------------------
  let rays = "";
  for (const a of [-58, -40, -24, -10, 4, 18, 34, 52]) {
    const rad = (a * Math.PI) / 180, len = 820, wdt = 26 + Math.abs(a) * 0.4;
    const x2 = SUN.x + Math.sin(rad) * len, y2 = SUN.y - Math.cos(rad) * len;
    const nx = Math.cos(rad) * wdt, ny = Math.sin(rad) * wdt;
    rays += `<polygon points="${f(SUN.x)},${f(SUN.y)} ${f(x2 - nx)},${f(y2 - ny)} ${f(x2 + nx)},${f(y2 + ny)}" fill="url(#a-ray)"/>`;
  }
  out.push(`<g style="mix-blend-mode:screen" opacity="0.22" filter="url(#a-b16)">${rays}</g>`);
  let motes = "";
  for (let i = 0; i < 70; i++) {
    const mx = 900 + r() * 1000, my = 540 + r() * 460;
    motes += `<circle cx="${f(mx)}" cy="${f(my)}" r="${f(0.8 + r() * 2.2)}" fill="#ffe2a8" opacity="${f(0.2 + r() * 0.55)}"/>`;
  }
  out.push(`<g style="mix-blend-mode:screen">${motes}</g>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#a-warm)" style="mix-blend-mode:soft-light"/>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#a-vignette)"/>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#a-leftdark)"/>`);
  out.push(`<rect width="${W}" height="${H}" filter="url(#a-grain)" opacity="0.2" style="mix-blend-mode:overlay"/>`);

  const defs = `
  ${commonDefs("a")}
  <linearGradient id="a-sky" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0c1038"/><stop offset="0.16" stop-color="#1e2562"/><stop offset="0.3" stop-color="#4c4a8e"/><stop offset="0.4" stop-color="#9a6a98"/><stop offset="0.47" stop-color="#e29a84"/><stop offset="0.53" stop-color="#f6c07c"/><stop offset="0.6" stop-color="#fbdc9c"/><stop offset="1" stop-color="#fbdc9c"/>
  </linearGradient>
  <radialGradient id="a-sunglow"><stop offset="0" stop-color="#ffe3a0" stop-opacity="0.95"/><stop offset="0.22" stop-color="#ffb867" stop-opacity="0.6"/><stop offset="0.55" stop-color="#d9708a" stop-opacity="0.22"/><stop offset="1" stop-color="#d9708a" stop-opacity="0"/></radialGradient>
  <radialGradient id="a-sunglow2"><stop offset="0" stop-color="#fffbe9" stop-opacity="0.95"/><stop offset="1" stop-color="#ffe3a0" stop-opacity="0"/></radialGradient>
  <linearGradient id="a-horizonhaze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffcf9a" stop-opacity="0"/><stop offset="0.6" stop-color="#ffcf9a" stop-opacity="0.6"/><stop offset="1" stop-color="#ffcf9a" stop-opacity="0"/></linearGradient>
  <linearGradient id="a-fog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffcf9a" stop-opacity="0"/><stop offset="0.6" stop-color="#e6a98a" stop-opacity="0.42"/><stop offset="1" stop-color="#6b6fa6" stop-opacity="0"/></linearGradient>
  <linearGradient id="a-fog2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6a98a" stop-opacity="0"/><stop offset="0.5" stop-color="#b58aa6" stop-opacity="0.38"/><stop offset="1" stop-color="#2d3a63" stop-opacity="0"/></linearGradient>
  <linearGradient id="a-road" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#b79a78"/><stop offset="0.5" stop-color="#d9b88a"/><stop offset="1" stop-color="#ffe0a8"/></linearGradient>
  <linearGradient id="a-rock" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#47507a"/><stop offset="0.5" stop-color="#262e4e"/><stop offset="1" stop-color="#0d1226"/></linearGradient>
  <linearGradient id="a-ground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a2342"/><stop offset="1" stop-color="#070c1f"/></linearGradient>
  <linearGradient id="a-seam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0a1024" stop-opacity="0.95"/><stop offset="0.7" stop-color="#0a1024" stop-opacity="0.35"/><stop offset="1" stop-color="#0a1024" stop-opacity="0"/></linearGradient>
  <linearGradient id="a-ray" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe3a0" stop-opacity="0.6"/><stop offset="1" stop-color="#ffe3a0" stop-opacity="0"/></linearGradient>
  <radialGradient id="a-warm" cx="0.53" cy="0.55" r="0.6"><stop offset="0" stop-color="#ffb35c" stop-opacity="0.55"/><stop offset="1" stop-color="#ffb35c" stop-opacity="0"/></radialGradient>
  <radialGradient id="a-vignette" cx="0.55" cy="0.55" r="0.75"><stop offset="0.55" stop-color="#05071a" stop-opacity="0"/><stop offset="1" stop-color="#05071a" stop-opacity="0.4"/></radialGradient>
  <linearGradient id="a-leftdark" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#07091f" stop-opacity="0.3"/><stop offset="0.5" stop-color="#07091f" stop-opacity="0.06"/><stop offset="0.75" stop-color="#07091f" stop-opacity="0"/></linearGradient>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${out.join("\n")}</svg>`;
}
