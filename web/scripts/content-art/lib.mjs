// Tiny procedural-SVG toolkit for the AzerDex editorial illustrations.
// Everything is deterministic (seeded RNG): re-running the build yields byte-identical SVG.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const f = (n) => (Math.round(n * 10) / 10).toString();
export const pts = (arr) => arr.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");
export const mix = (a, b, t) => a + (b - a) * t;

/** Hex colour mix, t=0 -> a, t=1 -> b. */
export function mixHex(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const h = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${h(mix(r1, r2, t))}${h(mix(g1, g2, t))}${h(mix(b1, b2, t))}`;
}

/** Midpoint-displacement ridge line from x0..x1, returns [[x,y],...]. */
export function ridgeLine({ x0 = -40, x1 = 1960, y, amp, rough = 0.55, steps = 7, seed, bias = null }) {
  const r = rng(seed);
  let p = [[x0, y + (r() - 0.5) * amp], [x1, y + (r() - 0.5) * amp]];
  let a = amp;
  for (let s = 0; s < steps; s++) {
    const n = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1];
      n.push([(ax + bx) / 2, (ay + by) / 2 + (r() - 0.5) * a], p[i + 1]);
    }
    p = n;
    a *= rough;
  }
  if (bias) p = p.map(([x, yy]) => [x, yy + bias(x)]);
  return p;
}

export function ridgePath(line, bottom = 1100) {
  const [fx] = line[0], [lx] = line[line.length - 1];
  return `M${f(fx)},${bottom} L${line.map(([x, y]) => `${f(x)},${f(y)}`).join(" L")} L${f(lx)},${bottom} Z`;
}

/** Stylised conifer: four overlapping triangular tiers + trunk, right half shaded. */
export function pine(x, y, h, fill, shade) {
  const n = 4, trunkH = h * 0.1, body = h - trunkH, w = h * 0.2;
  let s = `<rect x="${f(x - h * 0.02)}" y="${f(y - trunkH)}" width="${f(h * 0.04)}" height="${f(trunkH)}" fill="${shade}"/>`;
  for (let i = 0; i < n; i++) {
    const yt = y - h + i * body * 0.2;
    const yb = yt + body * 0.4;
    const ww = w * (0.5 + (0.5 * (i + 1)) / n);
    s += `<polygon points="${f(x)},${f(yt)} ${f(x + ww)},${f(yb)} ${f(x - ww)},${f(yb)}" fill="${fill}"/>`;
    s += `<polygon points="${f(x)},${f(yt)} ${f(x + ww)},${f(yb)} ${f(x + ww * 0.1)},${f(yb)}" fill="${shade}" opacity="0.55"/>`;
  }
  return s;
}

/** Ribbon polygon along a Catmull-Rom-ish polyline with variable width. */
export function ribbon(path, widthAt) {
  const n = path.length;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const w = widthAt(i / (n - 1)) / 2;
    L.push([path[i][0] - dy * w, path[i][1] + dx * w]);
    R.push([path[i][0] + dy * w, path[i][1] - dx * w]);
  }
  return [...L, ...R.reverse()];
}

/** Sample a cubic Bezier chain (array of [p0,c1,c2,p1] segments) into points. */
export function sampleBezier(segs, per = 18) {
  const out = [];
  for (const [p0, c1, c2, p1] of segs) {
    for (let i = 0; i <= per; i++) {
      const t = i / per, u = 1 - t;
      out.push([
        u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
        u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1],
      ]);
    }
  }
  return out;
}

/** Jagged lightning polyline. */
export function bolt(x0, y0, x1, y1, seed, jitter = 26, segs = 14) {
  const r = rng(seed);
  const p = [[x0, y0]];
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    p.push([mix(x0, x1, t) + (r() - 0.5) * jitter * 2, mix(y0, y1, t) + (r() - 0.5) * jitter]);
  }
  p.push([x1, y1]);
  return p;
}

/** Shared SVG filters: grain, paint wobble, soft blurs. */
export function commonDefs(prefix = "c") {
  return `
  <filter id="${prefix}-grain" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0.9 0.9 0.9 0 -0.9"/>
  </filter>
  <filter id="${prefix}-paint" x="-5%" y="-5%" width="110%" height="110%">
    <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="3" result="t"/>
    <feDisplacementMap in="SourceGraphic" in2="t" scale="9" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="${prefix}-wobble" x="-5%" y="-5%" width="110%" height="110%">
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="11" result="t"/>
    <feDisplacementMap in="SourceGraphic" in2="t" scale="3.2" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
  <filter id="${prefix}-b2"><feGaussianBlur stdDeviation="2"/></filter>
  <filter id="${prefix}-b4"><feGaussianBlur stdDeviation="4"/></filter>
  <filter id="${prefix}-b8"><feGaussianBlur stdDeviation="8"/></filter>
  <filter id="${prefix}-b16"><feGaussianBlur stdDeviation="16"/></filter>
  <filter id="${prefix}-b30" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="30"/></filter>
  <filter id="${prefix}-snow" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.011 0.02" numOctaves="4" seed="21" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 7 -3.1"/>
  </filter>`;
}


/**
 * A single craggy mountain peak with a lit and a shaded face and a snow cap.
 * litSide: -1 = left face catches the light, +1 = right face. Returns SVG.
 */
export function peak({ cx, by, h, wl, wr, seed, litSide, rock, rockShade, snow, snowShade, snowDepth = 0.4 }) {
  const r = rng(seed);
  const apex = [cx + (r() - 0.5) * wl * 0.15, by - h];
  const edge = (foot, sign) => {
    const out = [foot];
    const n = 7;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = mix(foot[0], apex[0], t), y = mix(foot[1], apex[1], t);
      const j = (r() - 0.5) * h * 0.1 * (1 - t * 0.4) + sign * Math.sin(t * 3.1) * h * 0.04;
      out.push([x + j, y + (r() - 0.5) * h * 0.03]);
    }
    out.push(apex);
    return out;
  };
  const L = edge([cx - wl, by], -1), Rg = edge([cx + wr, by], 1);
  // crease from apex to a point on the base, slightly jagged
  const crease = [apex];
  const cEnd = [cx + (r() - 0.5) * (wl + wr) * 0.18, by];
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    crease.push([mix(apex[0], cEnd[0], t) + (r() - 0.5) * h * 0.08 * t, mix(apex[1], cEnd[1], t)]);
  }
  crease.push(cEnd);
  const full = [...L.slice(0, -1), apex, ...Rg.slice().reverse().slice(1)];
  const leftFace = [...L, ...crease.slice().reverse().slice(1)];
  const rightFace = [...Rg, ...crease.slice().reverse().slice(1)];
  const dark = litSide < 0 ? rightFace : leftFace;
  // snow: walk the edges down to snowDepth with a ragged lower boundary
  const snowPts = (face) => {
    const edgeIdx = face === leftFace ? L : Rg;
    const base = edgeIdx.slice().reverse(); // apex -> foot
    const top = base.filter((p) => p[1] < apex[1] + h * snowDepth);
    const c = crease.filter((p) => p[1] < apex[1] + h * snowDepth * 0.9);
    const ragged = c.map(([x, y], i) => [x, y + (i % 2 ? 1 : -1) * h * 0.035 * r()]).reverse();
    return [...top, ...ragged];
  };
  let g = `<polygon points="${pts(full)}" fill="${rock}"/>`;
  g += `<polygon points="${pts(dark)}" fill="${rockShade}"/>`;
  g += `<polygon points="${pts(snowPts(litSide < 0 ? rightFace : leftFace))}" fill="${snowShade}"/>`;
  g += `<polygon points="${pts(snowPts(litSide < 0 ? leftFace : rightFace))}" fill="${snow}"/>`;
  // a few ridge streaks on the rock
  for (let i = 0; i < 5; i++) {
    const t0 = 0.35 + r() * 0.5;
    const sx = mix(apex[0], litSide < 0 ? cx - wl * 0.6 : cx + wr * 0.6, t0) + (r() - 0.5) * 20;
    const sy = mix(apex[1], by, t0);
    g += `<path d="M${f(sx)},${f(sy)} l${f(-6 + r() * 12)},${f(h * 0.1)}" stroke="${rockShade}" stroke-width="${f(2 + r() * 3)}" opacity="0.5"/>`;
  }
  return g;
}

/** Cloud cluster: overlapping soft blobs with a lit underside. */
export function cloudCluster({ cx, cy, w, h, seed, body, lit, litAmt = 0.6, n = 7 }) {
  const r = rng(seed);
  let g = "";
  for (let i = 0; i < n; i++) {
    const ex = cx + (r() - 0.5) * w, ey = cy + (r() - 0.5) * h * 1.2;
    const rx = w * (0.14 + r() * 0.18), ry = h * (0.35 + r() * 0.5);
    g += `<ellipse cx="${f(ex)}" cy="${f(ey)}" rx="${f(rx)}" ry="${f(ry)}" fill="${body}" opacity="0.55"/>`;
    g += `<ellipse cx="${f(ex)}" cy="${f(ey + ry * 0.5)}" rx="${f(rx * 0.92)}" ry="${f(ry * 0.5)}" fill="${lit}" opacity="${f(litAmt)}"/>`;
  }
  return g;
}
