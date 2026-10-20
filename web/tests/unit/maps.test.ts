import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ZoneMapPoc } from "@/components/maps/ZoneMapPoc";
import { ALLOWED_ASSET_HOSTS, assetOrigin, parseAssetBase, resolveMapAssetUrl } from "@/lib/maps/asset-url";
import { imageBounds, isValidPercent, latLngToPercent, percentToLatLng, percentToPixel } from "@/lib/maps/coordinates";
import { loadManifest, parseManifest } from "@/lib/maps/manifest";
import { LEVELED_KINDS, NO_FILTER, clusterPoints, countByKind, filterPoints, pointsForMap, totalObservations, type MapPoint } from "@/lib/maps/observations";
import { mapsPocEnabled } from "@/lib/maps/poc-gate";
import { zoneObservations } from "@/lib/maps/zone-observations";
import { buildPageCsp } from "@/lib/security/headers";
import sample from "@/lib/data/fixture/public-projection.sample.json";

const manifestJson = JSON.parse(readFileSync(resolve(__dirname, "../../public/maps/forever/1420/v1/manifest.json"), "utf8"));
const SIZE = { width: 1002, height: 668 };

describe("manifest", () => {
  it("parses the shipped Tirisfal manifest", () => {
    const r = parseManifest(manifestJson);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.zoneId).toBe(1420);
      expect(r.manifest.image).toMatchObject({ width: 1002, height: 668, format: "webp" });
      expect(r.manifest.calibration.status).toBe("provisional");
      expect((r.manifest.provenance as Record<string, unknown>).mapArtId).toBeNull();
    }
  });
  it("matches the bytes of the shipped image", async () => {
    const { createHash } = await import("node:crypto");
    const buf = readFileSync(resolve(__dirname, "../../public/maps/forever/1420/v1/tirisfal-glades.webp"));
    expect(createHash("sha256").update(buf).digest("hex")).toBe(manifestJson.image.sha256);
    expect(buf.length).toBe(manifestJson.image.bytes);
  });
  it.each([
    ["wrong origin", { ...manifestJson, projection: { ...manifestJson.projection, origin: "bottom-left" } }],
    ["zero width", { ...manifestJson, image: { ...manifestJson.image, width: 0 } }],
    ["path-like file", { ...manifestJson, image: { ...manifestJson.image, file: "../x.webp" } }],
    ["bad version", { ...manifestJson, version: "latest" }],
    ["unknown calibration", { ...manifestJson, calibration: { status: "great" } }],
    ["not an object", 42],
  ])("rejects %s", (_n, bad) => expect(parseManifest(bad).ok).toBe(false));

  it("loadManifest maps failures to results instead of throwing", async () => {
    const json = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
    expect(await loadManifest("/x", json(manifestJson))).toMatchObject({ ok: true });
    expect(await loadManifest("/x", json({}, false))).toEqual({ ok: false, error: "unavailable" });
    expect(await loadManifest("/x", (async () => { throw new Error("net"); }) as unknown as typeof fetch)).toEqual({ ok: false, error: "unavailable" });
    expect(await loadManifest("/x", (async () => ({ ok: true, json: async () => { throw new Error("bad"); } })) as unknown as typeof fetch)).toEqual({ ok: false, error: "invalid_json" });
    expect(await loadManifest("/x", json({ nope: 1 }))).toEqual({ ok: false, error: "invalid_manifest" });
  });
});

describe("asset URL resolver", () => {
  it("defaults to same-origin /maps", () => {
    expect(resolveMapAssetUrl(undefined, 1420, "v1", "manifest.json")).toBe("/maps/forever/1420/v1/manifest.json");
    expect(resolveMapAssetUrl("", 1420, "v1", "tirisfal-glades.webp")).toBe("/maps/forever/1420/v1/tirisfal-glades.webp");
  });
  it("accepts allow-listed https hosts and trims slashes", () => {
    expect(resolveMapAssetUrl("https://azerdex-assets.pages.dev/", 1420, "v1", "manifest.json")).toBe("https://azerdex-assets.pages.dev/forever/1420/v1/manifest.json");
    expect(parseAssetBase("https://assets.azerdex.com")).toBe("https://assets.azerdex.com");
    expect(assetOrigin("https://assets.azerdex.com/x/")).toBe("https://assets.azerdex.com");
    expect(assetOrigin(undefined)).toBeNull();
    expect(ALLOWED_ASSET_HOSTS).not.toContain("*");
  });
  it.each([
    "http://assets.azerdex.com", "https://evil.example", "https://azerdex-assets.pages.dev.evil.example", "https://user:pw@assets.azerdex.com",
    "https://assets.azerdex.com:8443", "https://assets.azerdex.com/?q=1", "//evil.example/maps", "javascript:alert(1)", "data:text/html,x", "/maps/../etc",
  ])("rejects base %s", (bad) => {
    expect(parseAssetBase(bad)).toBeNull();
    expect(assetOrigin(bad)).toBeNull();
    // a rejected base never reaches the network: resolution falls back to same-origin
    expect(resolveMapAssetUrl(bad, 1420, "v1", "manifest.json")).toBe("/maps/forever/1420/v1/manifest.json");
  });
  it("rejects malformed path components", () => {
    expect(() => resolveMapAssetUrl(undefined, 0, "v1", "a.webp")).toThrow();
    expect(() => resolveMapAssetUrl(undefined, 1420, "../v1", "a.webp")).toThrow();
    expect(() => resolveMapAssetUrl(undefined, 1420, "v1", "../a.webp")).toThrow();
    expect(() => resolveMapAssetUrl(undefined, 1420, "v1", "a/b.webp")).toThrow();
  });
});

describe("coordinates", () => {
  it("matches the Companion pixel model", () => {
    expect(percentToPixel(SIZE, 0, 0)).toEqual({ px: 0, py: 0 });
    expect(percentToPixel(SIZE, 50, 50)).toEqual({ px: 501, py: 334 });
    expect(percentToPixel(SIZE, 100, 100)).toEqual({ px: 1002, py: 668 });
  });
  it("inverts Y for Leaflet CRS.Simple ([lat,lng] = [y,x])", () => {
    expect(percentToLatLng(SIZE, 0, 0)).toEqual([668, 0]); // top-left = highest lat
    expect(percentToLatLng(SIZE, 50, 50)).toEqual([334, 501]);
    expect(percentToLatLng(SIZE, 100, 100)).toEqual([0, 1002]); // bottom-right
    expect(imageBounds(SIZE)).toEqual([[0, 0], [668, 1002]]);
  });
  it.each<[number, number]>([[10, 20], [25, 75], [63.5, 12.25], [91, 88]])("asymmetric (%f,%f): pixel/latlng agree and round-trip", (x, y) => {
    const px = percentToPixel(SIZE, x, y)!;
    const ll = percentToLatLng(SIZE, x, y)!;
    expect(ll[1]).toBeCloseTo(px.px, 9);
    expect(ll[0]).toBeCloseTo(SIZE.height - px.py, 9);
    const back = latLngToPercent(SIZE, ll[0], ll[1]);
    expect(back.x).toBeCloseTo(x, 9);
    expect(back.y).toBeCloseTo(y, 9);
  });
  it("rejects invalid / out-of-range input instead of clamping", () => {
    for (const [x, y] of [[-0.1, 5], [5, 100.1], [NaN, 1], [1, Infinity], [101, 50]] as [number, number][]) {
      expect(isValidPercent(x, y)).toBe(false);
      expect(percentToPixel(SIZE, x, y)).toBeNull();
      expect(percentToLatLng(SIZE, x, y)).toBeNull();
    }
  });
});

describe("observations (synthetic fixture)", () => {
  const z = zoneObservations(1420);
  it("selects only mapId 1420 and preserves every published location", () => {
    const published = sample.projection.locations.filter((l) => l.map_id === 1420);
    expect(z.synthetic).toBe(true);
    expect(z.points.length).toBe(published.length);
    expect(totalObservations(z.points)).toBe(published.reduce((a, l) => a + l.observations, 0));
    expect(z.points.every((p) => p.mapId === 1420)).toBe(true);
    expect(pointsForMap(z.points, 1421)).toEqual([]);
    expect(zoneObservations(1421).points.length).toBe(sample.projection.locations.filter((l) => l.map_id === 1421).length);
  });
  it("exposes no contributor / per-installation fields", () => {
    expect(Object.keys(z.points[0]!).sort()).toEqual(["id", "level", "lootKind", "mapId", "observations", "sourceId", "sourceName", "sourceType", "subzone", "x", "y"]);
  });
  it("mining filter returns exactly the mining points", () => {
    const mining = filterPoints(z.points, { ...NO_FILTER, kinds: new Set(["mining" as const]) });
    expect(mining.length).toBe(countByKind(z.points).mining);
    expect(mining.length).toBeGreaterThan(0);
    expect(mining.every((p) => p.lootKind === "mining")).toBe(true);
  });
  it("only represents categories present in the data", () => {
    const kinds = Object.keys(countByKind(z.points)).sort();
    expect(kinds).toEqual([...new Set(sample.projection.locations.filter((l) => l.map_id === 1420).map((l) => l.loot_kind))].sort());
  });
  it("creature-level filter applies to leveled kinds only", () => {
    const mob = z.points.filter((p) => p.lootKind === "mob");
    const lv = [...new Set(mob.map((p) => p.level))].sort((a, b) => a - b);
    expect(lv.length).toBeGreaterThan(1);
    const f = filterPoints(z.points, { ...NO_FILTER, levelMin: lv[1]!, levelMax: lv[1]! });
    for (const p of f) if (LEVELED_KINDS.has(p.lootKind)) expect(p.level).toBe(lv[1]);
    expect(f.some((p) => p.lootKind === "mining")).toBe(true); // mining unaffected by level
    expect(f.filter((p) => p.lootKind === "mob").length).toBe(mob.filter((p) => p.level === lv[1]).length);
  });
  it("cluster mode preserves counts and observations", () => {
    for (const cell of [1, 6, 25]) {
      const cl = clusterPoints(z.points, cell);
      expect(cl.reduce((a, c) => a + c.pointCount, 0)).toBe(z.points.length);
      expect(cl.reduce((a, c) => a + c.observations, 0)).toBe(totalObservations(z.points));
      expect(cl.every((c) => c.x >= 0 && c.x <= 100 && c.y >= 0 && c.y <= 100)).toBe(true);
    }
    expect(clusterPoints(z.points, 25).length).toBeLessThan(clusterPoints(z.points, 1).length);
  });
  it("clustering ignores invalid coordinates", () => {
    const bad: MapPoint = { ...z.points[0]!, id: "bad", x: 101 };
    expect(clusterPoints([bad], 5)).toEqual([]);
    expect(pointsForMap([bad], 1420)).toEqual([]);
  });
});

describe("POC gate, CSP, SSR safety", () => {
  it("is off by default and never in production", () => {
    expect(mapsPocEnabled({})).toBe(false);
    expect(mapsPocEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(mapsPocEnabled({ AZERDEX_POC_MAPS: "1" })).toBe(true);
    expect(mapsPocEnabled({ AZERDEX_POC_MAPS: "1", FOREVERDB_DEPLOYMENT: "production" })).toBe(false);
    expect(mapsPocEnabled({ NODE_ENV: "development", FOREVERDB_DEPLOYMENT: "production" })).toBe(false);
    expect(mapsPocEnabled({ NODE_ENV: "development" })).toBe(true);
  });
  it("CSP is unchanged by default and widens only img-src/connect-src for an allow-listed asset origin", () => {
    const base = buildPageCsp("n", { dev: false, turnstile: false, https: true });
    expect(buildPageCsp("n", { dev: false, turnstile: false, https: true, assetOrigin: null })).toBe(base);
    const withAsset = buildPageCsp("n", { dev: false, turnstile: false, https: true, assetOrigin: "https://assets.azerdex.com" });
    const dir = (c: string, n: string) => c.split("; ").find((d) => d.startsWith(`${n} `));
    for (const d of ["script-src", "style-src", "default-src", "frame-src", "worker-src", "font-src"]) expect(dir(withAsset, d)).toBe(dir(base, d));
    expect(dir(withAsset, "img-src")).toBe("img-src 'self' data: https://assets.azerdex.com");
    expect(dir(withAsset, "connect-src")).toBe("connect-src 'self' https://assets.azerdex.com");
    expect(withAsset).not.toMatch(/\*|unsafe-inline|unsafe-eval/);
  });
  it("server render shows an accessible loading status and never touches window", () => {
    expect(typeof window).toBe("undefined");
    const html = renderToString(createElement(ZoneMapPoc, { zoneId: 1420, zoneName: "Tirisfal Glades", version: "v1", points: zoneObservations(1420).points }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading map");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("leaflet-container");
  });
  it("Leaflet is only imported dynamically (SSR-safe) and the viewer sets no inline style markup", () => {
    const src = readFileSync(resolve(__dirname, "../../src/components/maps/ZoneMapViewer.tsx"), "utf8");
    expect(src).not.toMatch(/^import\s+(?!type)[^;]*from\s+"leaflet"/m);
    expect(src).toContain('await import("leaflet")');
    expect(src).not.toMatch(/style=\{|style="|innerHTML/);
  });
});
