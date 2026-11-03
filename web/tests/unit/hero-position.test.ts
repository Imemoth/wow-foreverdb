import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZoneCinematicHero } from "@/components/zones/ZoneCinematicHero";
import { heroPositionClass } from "@/lib/maps/hero-position";
import { CINEMATIC_ZONE_ARTWORK, resolveZoneArtwork, type ResolvedZoneArtwork } from "@/lib/maps/zone-artwork";

const CSS = readFileSync(join(__dirname, "../../src/app/globals.css"), "utf8");
const rules = [...CSS.matchAll(/^\.(hero-pos-\d+-\d+)\s*\{\s*object-position:\s*([^;}]+?)\s*;?\s*\}/gm)].map((m) => ({ cls: m[1]!, value: m[2]! }));

describe("heroPositionClass", () => {
  it("maps whole-percent pairs to a class name", () => {
    expect(heroPositionClass("85% 50%")).toBe("hero-pos-85-50");
    expect(heroPositionClass("0% 100%")).toBe("hero-pos-0-100");
    expect(heroPositionClass("5% 5%")).toBe("hero-pos-5-5");
  });
  it("rejects everything else (never a class name or CSS fragment): keywords, lengths, decimals, >100, injection", () => {
    for (const bad of ["center", "85% 50", "85%  50%", "85.5% 50%", "101% 50%", "1000% 1%", "-5% 50%", "85px 50%", "85% 50%;background:url(x)", "85% 50%\" onload=\"x", "", " 85% 50%", "85% 50% "]) {
      expect(heroPositionClass(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(heroPositionClass(null)).toBeNull();
    expect(heroPositionClass(undefined)).toBeNull();
  });
});

describe("stylesheet stays in step with the per-zone configuration", () => {
  const registered = Object.entries(CINEMATIC_ZONE_ARTWORK).map(([id, a]) => ({ id, pos: a.objectPosition, cls: heroPositionClass(a.objectPosition) }));
  it("every registered zone has a valid position, a class, and a stylesheet rule with exactly that object-position", () => {
    expect(registered.length).toBeGreaterThanOrEqual(2);
    for (const z of registered) {
      expect(z.cls, `zone ${z.id}: ${z.pos}`).not.toBeNull();
      expect(rules.find((r) => r.cls === z.cls)?.value, `rule for ${z.cls}`).toBe(z.pos);
    }
  });
  it("no dead rules: every .hero-pos-* rule belongs to a registered zone", () => {
    expect(rules.map((r) => r.cls).sort()).toEqual([...new Set(registered.map((z) => z.cls))].sort());
  });
  it("positions stay configurable per zone (Hillsbrad and Duskwood differ)", () => {
    expect(new Set(registered.map((z) => z.cls)).size).toBe(registered.length);
  });
});

describe("rendered hero image (CSP: no inline style attribute)", () => {
  const html = (art: ResolvedZoneArtwork) => renderToStaticMarkup(createElement(ZoneCinematicHero, { zoneName: "Z", stats: null, artwork: art }));
  const img = (h: string) => /<img[^>]*fetchPriority="high"[^>]*>/.exec(h)![0];

  it("Hillsbrad and Duskwood use their own class and carry no style attribute and no centred default", () => {
    const a = img(html(resolveZoneArtwork(1424))), b = img(html(resolveZoneArtwork(1431)));
    expect(a).toContain("hero-pos-85-50");
    expect(b).toContain("hero-pos-85-45");
    for (const t of [a, b]) {
      expect(t).not.toMatch(/\sstyle=/);
      expect(t).not.toContain("object-center");
      expect(t).toContain("object-cover");
      expect(t).toContain('fetchPriority="high"');
    }
  });
  it("an unusable position keeps the centred default instead of emitting a bogus class", () => {
    const art = resolveZoneArtwork(1424);
    if (art.kind !== "cinematic") throw new Error("expected cinematic");
    const t = img(html({ kind: "cinematic", art: { ...art.art, objectPosition: "left;top" } }));
    expect(t).toContain("object-center");
    expect(t).not.toContain("hero-pos-");
    expect(t).not.toMatch(/\sstyle=/);
  });
  it("no inline object-position remains anywhere in the zone hero component", () => {
    expect(readFileSync(join(__dirname, "../../src/components/zones/ZoneCinematicHero.tsx"), "utf8")).not.toMatch(/style=\{\{[^}]*objectPosition/);
  });
});
