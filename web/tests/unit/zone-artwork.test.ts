import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZoneCinematicHero } from "@/components/zones/ZoneCinematicHero";
import { resolveZoneHeroUrl } from "@/lib/maps/asset-url";
import type { AtlasMap } from "@/lib/maps/atlas/schema";
import { CINEMATIC_ZONE_ARTWORK, HERO_FOCAL_CLASS, heroFileName, resolveZoneArtwork, type ResolvedZoneArtwork } from "@/lib/maps/zone-artwork";
import { heroCdnBase, heroImgOrigin } from "@/lib/maps/zone-maps-gate";
import { buildPageCsp } from "@/lib/security/headers";

const PUBLIC = join(__dirname, "../../public");

const atlas = (over: Partial<AtlasMap> = {}): AtlasMap => ({
  uiMapId: 1420, internalMapId: 1, name: "Tirisfal Glades", slug: "tirisfal-glades", category: "zone", typeName: "zone",
  parentUiMapId: 1, availability: "available", latestVersion: "v1", versions: ["v1"], hasFullReveal: false, defaultVariant: "base",
  image: { variant: "base", path: "forever/1420/v1/base.webp", width: 1002, height: 668, bytes: 1, sha256: "a".repeat(64) },
  variants: [], manifest: "forever/1420/v1/manifest.json", ...over,
} as unknown as AtlasMap);

describe("zone artwork resolution", () => {
  it("Hillsbrad Foothills (1424) resolves to its cinematic artwork, and every referenced file exists", () => {
    const r = resolveZoneArtwork(1424);
    expect(r.kind).toBe("cinematic");
    for (const s of [...CINEMATIC_ZONE_ARTWORK[1424]!.desktop, ...CINEMATIC_ZONE_ARTWORK[1424]!.mobile]) {
      expect(existsSync(join(PUBLIC, s.src)), s.src).toBe(true);
    }
  });

  it("Duskwood (1431) resolves to its own cinematic artwork; every file exists and no entry shares files with another zone", () => {
    expect(resolveZoneArtwork(1431).kind).toBe("cinematic");
    const art = CINEMATIC_ZONE_ARTWORK[1431]!;
    for (const s of [...art.desktop, ...art.mobile]) expect(existsSync(join(PUBLIC, s.src)), s.src).toBe(true);
    const owner = new Map<string, number>();
    for (const [id, a] of Object.entries(CINEMATIC_ZONE_ARTWORK)) for (const s of [...a.desktop, ...a.mobile]) {
      expect(owner.get(s.src), `${s.src} shared`).toBeUndefined();
      owner.set(s.src, Number(id));
      expect(s.src).toContain(`/${id}-`); // files are named by the stable uiMapID they belong to
    }
  });

  it("cinematic artwork wins over an available atlas map", () => {
    expect(resolveZoneArtwork(1424, atlas({ uiMapId: 1424 })).kind).toBe("cinematic");
  });

  it("falls back to the atlas map, then to the vector backdrop", () => {
    const m = resolveZoneArtwork(1420, atlas(), "/maps");
    expect(m).toMatchObject({ kind: "map", src: "/maps/forever/1420/v1/base.webp", width: 1002, height: 668 });
    expect(resolveZoneArtwork(1420, atlas({ availability: "unavailable" })).kind).toBe("fallback");
    expect(resolveZoneArtwork(1420, undefined).kind).toBe("fallback");
    expect(resolveZoneArtwork(1420, atlas({ image: { variant: "base", path: "forever/1420/v1/..", width: 1, height: 1, bytes: 1, sha256: "a".repeat(64) } as AtlasMap["image"] })).kind).toBe("fallback");
  });

  it("never matches inherited object keys", () => {
    expect(resolveZoneArtwork(Number("constructor")).kind).toBe("fallback");
  });
});

describe("published hero artwork hygiene", () => {
  it("serves only the registered derivatives: no master/source/original files under public/zones/hero", () => {
    const files = readdirSync(join(PUBLIC, "zones/hero"));
    const registered = new Set(Object.values(CINEMATIC_ZONE_ARTWORK).flatMap((a) => [...a.desktop, ...a.mobile].map((s) => s.src.split("/").pop()!)));
    expect(files.sort()).toEqual([...registered].sort());
    for (const f of files) expect(f).not.toMatch(/source|master|original|raw/i);
  });
});

// --- V2-A: CDN-sourced hero artwork (versioned zone-heroes namespace), same-origin files kept as the rollback path -------------------

const CDN = "https://azerdex-assets.pages.dev";
const INVENTORY = JSON.parse(readFileSync(join(__dirname, "../../../scripts/map-atlas/heroes/zone-heroes.json"), "utf8")) as {
  zones: Record<string, { versions: Record<string, { renditions: { file: string; width: number; height: number; bytes: number; sha256: string; source: string }[] }> }>;
};
const cinematic = (r: ResolvedZoneArtwork) => { if (r.kind !== "cinematic") throw new Error("not cinematic"); return r.art; };

describe("CDN hero URL construction", () => {
  it("builds <host>/zone-heroes/<uiMapID>/<version>/<role>-<width>.webp for every registered rendition", () => {
    const urls: string[] = [];
    for (const [id, def] of Object.entries(CINEMATIC_ZONE_ARTWORK)) {
      const art = cinematic(resolveZoneArtwork(Number(id), undefined, undefined, CDN));
      expect(art.origin).toBe("cdn");
      def.desktop.forEach((r, i) => expect(art.desktop[i]).toEqual({ src: `${CDN}/zone-heroes/${id}/${def.version}/desktop-${r.width}.webp`, width: r.width }));
      def.mobile.forEach((r, i) => expect(art.mobile[i]).toEqual({ src: `${CDN}/zone-heroes/${id}/${def.version}/mobile-${r.width}.webp`, width: r.width }));
      urls.push(...art.desktop.map((s) => s.src), ...art.mobile.map((s) => s.src));
    }
    expect(urls.sort()).toEqual([
      `${CDN}/zone-heroes/1424/v1/desktop-1280.webp`, `${CDN}/zone-heroes/1424/v1/desktop-2000.webp`,
      `${CDN}/zone-heroes/1424/v1/mobile-600.webp`, `${CDN}/zone-heroes/1424/v1/mobile-900.webp`,
      `${CDN}/zone-heroes/1431/v1/desktop-1280.webp`, `${CDN}/zone-heroes/1431/v1/desktop-1916.webp`,
      `${CDN}/zone-heroes/1431/v1/mobile-600.webp`, `${CDN}/zone-heroes/1431/v1/mobile-900.webp`,
    ]);
  });

  it("the second allow-listed host works too; atlas map URLs are untouched by it", () => {
    expect(resolveZoneHeroUrl("https://assets.azerdex.com", 1431, "v1", "mobile-600.webp")).toBe("https://assets.azerdex.com/zone-heroes/1431/v1/mobile-600.webp");
    expect(resolveZoneArtwork(1420, atlas(), "/maps").kind).toBe("map");
  });

  it("rejects an invalid host: any non-allow-listed, non-https or decorated base keeps the same-origin files", () => {
    for (const bad of ["https://evil.example", "http://azerdex-assets.pages.dev", "https://azerdex-assets.pages.dev:8443", "https://u:p@azerdex-assets.pages.dev",
      "https://azerdex-assets.pages.dev.evil.example", "https://azerdex-assets.pages.dev/?x=1", "/maps", "//azerdex-assets.pages.dev", "*", "javascript:alert(1)"]) {
      expect(() => resolveZoneHeroUrl(bad, 1424, "v1", "desktop-1280.webp"), bad).toThrow("invalid_asset_base");
      const art = cinematic(resolveZoneArtwork(1424, undefined, undefined, bad));
      expect(art.origin, bad).toBe("local");
      expect(art.desktop.every((s) => s.src.startsWith("/zones/hero/"))).toBe(true);
    }
    expect(() => resolveZoneHeroUrl(undefined, 1424, "v1", "desktop-1280.webp")).toThrow("invalid_asset_base");
    expect(() => resolveZoneHeroUrl("", 1424, "v1", "desktop-1280.webp")).toThrow("invalid_asset_base");
  });

  it("rejects malformed zone ids, versions and file names (no traversal, no other formats)", () => {
    for (const id of [0, -1, 1.5, 1_000_000, NaN]) expect(() => resolveZoneHeroUrl(CDN, id, "v1", "desktop-1280.webp")).toThrow("invalid_zone_id");
    for (const v of ["1", "v0", "v01", "v1/../x", "V1", "v12345", ""]) expect(() => resolveZoneHeroUrl(CDN, 1424, v, "desktop-1280.webp")).toThrow("invalid_version");
    for (const f of ["../x.webp", "desktop-1280.png", "desktop-1280.webp?x", "master-2000.webp", "desktop-12.webp", "desktop-1280.webp/", "a/b.webp", ""]) {
      expect(() => resolveZoneHeroUrl(CDN, 1424, "v1", f), f).toThrow("invalid_file");
    }
  });
});

describe("hero source selection (default stays same-origin; the beta is not switched)", () => {
  it("default and every non-'cdn' value keep the same-origin files", () => {
    const asset = { NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: CDN };
    for (const env of [{}, asset, { ...asset, AZERDEX_ZONE_HERO_SOURCE: "" }, { ...asset, AZERDEX_ZONE_HERO_SOURCE: "local" }, { ...asset, AZERDEX_ZONE_HERO_SOURCE: "CDN" },
      { ...asset, AZERDEX_ZONE_HERO_SOURCE: "true" }, { ...asset, AZERDEX_ZONE_HERO_SOURCE: "1" }]) {
      expect(heroCdnBase(env), JSON.stringify(env)).toBeNull();
      expect(heroImgOrigin(env)).toBeNull();
    }
  });
  it("'cdn' needs the existing validated asset base; without it (or with a bad one) it silently stays same-origin", () => {
    expect(heroCdnBase({ AZERDEX_ZONE_HERO_SOURCE: "cdn" })).toBeNull();
    expect(heroCdnBase({ AZERDEX_ZONE_HERO_SOURCE: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: "/maps" })).toBeNull();
    for (const bad of ["https://evil.example", "http://azerdex-assets.pages.dev", "https://azerdex-assets.pages.dev:1"]) {
      expect(heroCdnBase({ AZERDEX_ZONE_HERO_SOURCE: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: bad }), bad).toBeNull();
    }
    const on = { AZERDEX_ZONE_HERO_SOURCE: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: CDN };
    expect(heroCdnBase(on)).toBe(CDN);
    expect(heroImgOrigin(on)).toBe(CDN);
  });
  it("selection order is unchanged by the source: cinematic wins over a map, other zones never become cinematic", () => {
    expect(resolveZoneArtwork(1424, atlas({ uiMapId: 1424 }), CDN, CDN).kind).toBe("cinematic");
    expect(resolveZoneArtwork(1431, undefined, undefined, CDN).kind).toBe("cinematic");
    expect(resolveZoneArtwork(1420, atlas(), CDN, CDN)).toMatchObject({ kind: "map", src: `${CDN}/forever/1420/v1/base.webp` });
    expect(resolveZoneArtwork(1420, undefined, undefined, CDN).kind).toBe("fallback");
    expect(resolveZoneArtwork(1426, atlas({ uiMapId: 1426 }), CDN, CDN).kind).toBe("map");
  });
  it("renditions, widths, intrinsic size and crop are identical for both sources; only the URL changes", () => {
    for (const id of [1424, 1431]) {
      const l = cinematic(resolveZoneArtwork(id)), c = cinematic(resolveZoneArtwork(id, undefined, undefined, CDN));
      expect(l.origin).toBe("local");
      expect(c.desktop.map((s) => s.width)).toEqual(l.desktop.map((s) => s.width));
      expect(c.mobile.map((s) => s.width)).toEqual(l.mobile.map((s) => s.width));
      expect([c.intrinsic, c.objectPosition]).toEqual([l.intrinsic, l.objectPosition]);
      // smallest first, the LAST desktop rendition is the <img src> fallback and the one the intrinsic size describes
      for (const list of [c.desktop, c.mobile]) expect(list.map((s) => s.width)).toEqual([...list.map((s) => s.width)].sort((a, b) => a - b));
      expect(c.desktop.at(-1)!.width).toBe(c.intrinsic.width);
    }
  });
});

describe("CDN artwork stays in step with the audited inventory (scripts/map-atlas/heroes/zone-heroes.json)", () => {
  it("version, published file names, widths and intrinsic sizes match; same-origin files are the inventoried sources with identical SHA-256", () => {
    expect(Object.keys(INVENTORY.zones).sort()).toEqual(Object.keys(CINEMATIC_ZONE_ARTWORK).sort());
    for (const [id, def] of Object.entries(CINEMATIC_ZONE_ARTWORK)) {
      const rs = INVENTORY.zones[id]!.versions[def.version]!.renditions;
      const published = [...def.desktop.map((r) => heroFileName("desktop", r.width)), ...def.mobile.map((r) => heroFileName("mobile", r.width))].sort();
      expect(rs.map((r) => r.file).sort()).toEqual(published);
      const largest = rs.filter((r) => r.file.startsWith("desktop")).sort((a, b) => b.width - a.width)[0]!;
      expect(def.intrinsic).toEqual({ width: largest.width, height: largest.height });
      for (const r of [...def.desktop, ...def.mobile]) {
        const role = def.desktop.includes(r) ? "desktop" : "mobile";
        const rec = rs.find((x) => x.file === heroFileName(role, r.width))!;
        expect(r.src).toBe(`/zones/hero/${rec.source}`);
        const bytes = readFileSync(join(PUBLIC, r.src));
        expect([bytes.length, createHash("sha256").update(bytes).digest("hex")]).toEqual([rec.bytes, rec.sha256]);
      }
    }
  });
  it("covers exactly the eight approved pilot derivatives (Hillsbrad 1424 and Duskwood 1431) and nothing private", () => {
    const all = Object.entries(INVENTORY.zones).flatMap(([id, z]) => Object.entries(z.versions).flatMap(([v, ver]) => ver.renditions.map((r) => `${id}/${v}/${r.file}`)));
    expect(all.sort()).toEqual(["1424/v1/desktop-1280.webp", "1424/v1/desktop-2000.webp", "1424/v1/mobile-600.webp", "1424/v1/mobile-900.webp",
      "1431/v1/desktop-1280.webp", "1431/v1/desktop-1916.webp", "1431/v1/mobile-600.webp", "1431/v1/mobile-900.webp"]);
    expect(JSON.stringify(INVENTORY)).not.toMatch(/\.(png|jpe?g)"|master\.|source\.webp/i);
  });
});

describe("ZoneCinematicHero is structurally unchanged and renders the CDN renditions", () => {
  const html = (art: ResolvedZoneArtwork) => renderToStaticMarkup(createElement(ZoneCinematicHero, { zoneName: "Hillsbrad Foothills", region: "Eastern Kingdoms", stats: null, artwork: art }));
  const imgTag = (h: string) => /<img[^>]*fetchPriority="high"[^>]*>/.exec(h)![0];

  it("keeps <picture>, the mobile <source>, srcset/sizes, intrinsic size and fetchPriority=high for the CDN source", () => {
    const h = html(resolveZoneArtwork(1424, undefined, undefined, CDN));
    expect(h).toContain(`<source media="(max-width: 639px)" srcSet="${CDN}/zone-heroes/1424/v1/mobile-600.webp 600w, ${CDN}/zone-heroes/1424/v1/mobile-900.webp 900w" sizes="100vw"/>`);
    const img = imgTag(h);
    expect(img).toContain(`src="${CDN}/zone-heroes/1424/v1/desktop-2000.webp"`);
    expect(img).toContain(`srcSet="${CDN}/zone-heroes/1424/v1/desktop-1280.webp 1280w, ${CDN}/zone-heroes/1424/v1/desktop-2000.webp 2000w"`);
    expect(img).toContain('sizes="(min-width: 1280px) 1232px, 100vw"');
    expect(img).toContain('width="2000"');
    expect(img).toContain('height="667"');
    expect(img).toContain('decoding="async"');
    expect(img).toContain('alt=""');
    // The crop is a compiled utility class, never an inline style: the nonce-based style-src (no 'unsafe-inline') blocks style="…".
    expect(img).not.toContain("style=");
    expect(img).toContain("object-[85%_50%]");
    expect(img).not.toContain("object-center");
    expect(h).toContain('data-artwork="cinematic"');
    expect(h).not.toMatch(/loading="lazy"/);
  });

  it("every registered crop has a literal focal class (Tailwind only emits classes it can read), and Duskwood keeps its own", () => {
    for (const [id, def] of Object.entries(CINEMATIC_ZONE_ARTWORK)) {
      const cls = HERO_FOCAL_CLASS[def.objectPosition];
      expect(cls, `zone ${id}`).toBe(`object-[${def.objectPosition.replace(/ /g, "_")}]`);
    }
    const duskwood = imgTag(html(resolveZoneArtwork(1431)));
    expect(duskwood).toContain("object-[85%_45%]");
    expect(duskwood).not.toContain("style=");
  });

  it("local and CDN markup are identical once the artwork URLs are normalised (same composition, same DOM)", () => {
    for (const id of [1424, 1431]) {
      const norm = (h: string) => h.replace(/(?:https:\/\/azerdex-assets\.pages\.dev\/zone-heroes\/\d+\/v1\/|\/zones\/hero\/\d+-[a-z-]+?-)(?:desktop-|mobile-)?(\d+)\.webp/g, "ART-$1.webp");
      expect(norm(html(resolveZoneArtwork(id, undefined, undefined, CDN)))).toBe(norm(html(resolveZoneArtwork(id))));
    }
  });

  it("picks the right rendition per viewport: phones get the mobile crop, larger screens the desktop panorama (Duskwood too)", () => {
    const h = html(resolveZoneArtwork(1431, undefined, undefined, CDN));
    expect(h).toMatch(/<source media="\(max-width: 639px\)" srcSet="[^"]*mobile-600\.webp 600w, [^"]*mobile-900\.webp 900w"/);
    expect(imgTag(h)).toContain("desktop-1916.webp 1916w");
    expect(imgTag(h)).not.toContain("mobile-");
    expect(imgTag(h)).toContain('width="1916"');
  });

  it("a map or fallback hero renders without any hero artwork request", () => {
    expect(html({ kind: "fallback" })).not.toMatch(/fetchPriority|zone-heroes|\/zones\/hero\/|<picture/);
    expect(html(resolveZoneArtwork(1426, atlas({ uiMapId: 1426 }), CDN, CDN))).not.toContain("zone-heroes");
  });
});

describe("CSP for CDN heroes", () => {
  const dir = (csp: string, name: string) => csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(name + " "));
  const base = { dev: false, turnstile: false, https: true };
  it("the hero origin widens img-src only (not connect-src, script-src or anything else) and only when passed", () => {
    const off = buildPageCsp("n", { ...base });
    const on = buildPageCsp("n", { ...base, heroImgOrigin: CDN });
    expect(dir(on, "img-src")).toBe(`img-src 'self' data: ${CDN}`);
    expect(dir(on, "connect-src")).toBe(dir(off, "connect-src"));
    for (const d of ["script-src", "style-src", "default-src", "frame-src", "form-action", "font-src"]) expect(dir(on, d)).toBe(dir(off, d));
    expect(off).not.toContain("azerdex-assets");
  });
  it("is not duplicated when the map origin is the same host, and both keep working together", () => {
    const both = buildPageCsp("n", { ...base, assetOrigin: CDN, heroImgOrigin: CDN });
    expect(dir(both, "img-src")).toBe(`img-src 'self' data: ${CDN}`);
    expect(dir(both, "connect-src")).toBe(`connect-src 'self' ${CDN}`);
  });
});
