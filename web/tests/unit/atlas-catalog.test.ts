import { describe, expect, it, vi } from "vitest";
import snapshot from "@/lib/maps/atlas/atlas-index.snapshot.json";
import { atlasIndexUrl, createAtlasCatalogLoader } from "@/lib/maps/atlas/catalog-loader";
import { parseAtlasIndex } from "@/lib/maps/atlas/schema";
import { artworkOf, buildZoneEntries, findDirectoryEntry, groupByContinent, observedOutsideCatalog } from "@/lib/maps/atlas/zone-catalog";
import type { ZoneSummary } from "@/lib/data/types";

const CDN = "https://azerdex-assets.pages.dev";
const parsed = parseAtlasIndex(snapshot);
if (!parsed.ok) throw new Error(parsed.error);
const index = parsed.index;
const clone = () => JSON.parse(JSON.stringify(snapshot));

describe("bundled atlas snapshot = the published inventory (build 1.60.1.70450)", () => {
  it("has the published inventory: 60 maps / 45 zones / 6 cities / 4 continents+... / 105 variants / 45 full-reveal", () => {
    const by = (c: string) => index.maps.filter((m) => m.category === c).length;
    expect(index.maps).toHaveLength(60);
    expect([by("zone"), by("city"), by("continent"), by("instance"), by("world")]).toEqual([45, 6, 4, 4, 1]);
    expect(index.maps.reduce((a, m) => a + m.variants.length, 0)).toBe(105);
    expect(index.maps.filter((m) => m.hasFullReveal)).toHaveLength(45);
    expect(index.currentBuild.version).toBe("1.60.1.70450");
  });
  it("every map is addressed by a unique uiMapId; duplicate slugs/names exist and are NOT identifiers", () => {
    expect(new Set(index.maps.map((m) => m.uiMapId)).size).toBe(60);
    const slugs = new Map<string, number[]>();
    for (const m of index.maps) slugs.set(m.slug, [...(slugs.get(m.slug) ?? []), m.uiMapId]);
    const dup = Object.fromEntries([...slugs].filter(([, ids]) => ids.length > 1));
    expect(dup).toEqual({ kalimdor: [1414, 1464], "eastern-kingdoms": [1415, 1463], "zephras-isle": [2521, 2665] });
  });
  it("Tirisfal resolves to the immutable v2 full-reveal; v1 stays published", () => {
    const t = index.maps.find((m) => m.uiMapId === 1420)!;
    expect(t.latestVersion).toBe("v2");
    expect(t.versions).toContain("v1");
    expect(t.image).toMatchObject({ variant: "full-reveal", path: "forever/1420/v2/full-reveal.webp", width: 1002, height: 668 });
  });
  it("records its provenance (index hash + approved ZIP hash)", () => {
    expect(snapshot.snapshot.indexJsonSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.snapshot.approvedDistributionZipSha256).toBe("f8a3df96cf9567c8abcd5b80b71d21f6ef44bb09fe455b70b8f32ea75c32c847");
  });
});

describe("atlas schema cross-checks reject a catalog as a whole", () => {
  it("duplicate uiMapId", () => { const c = clone(); c.maps[1].uiMapId = c.maps[0].uiMapId; expect(parseAtlasIndex(c)).toEqual({ ok: false, error: "duplicate_ui_map_id" }); });
  it("an image path that belongs to another map (never show another zone's art)", () => {
    const c = clone(); const m = c.maps.find((x: { uiMapId: number }) => x.uiMapId === 1420); m.image.path = "forever/1421/v2/full-reveal.webp";
    expect(parseAtlasIndex(c)).toEqual({ ok: false, error: "path_mismatch" });
  });
  it("a path that escapes the asset layout", () => {
    const c = clone(); c.maps[0].image.path = "forever/947/v1/../../x.webp";
    expect(parseAtlasIndex(c).ok).toBe(false);
    const d = clone(); d.maps[0].image.path = "https://evil.example/forever/947/v1/base.webp";
    expect(parseAtlasIndex(d).ok).toBe(false);
  });
  it("latest version that is not published", () => { const c = clone(); c.maps[0].latestVersion = "v9"; expect(parseAtlasIndex(c)).toEqual({ ok: false, error: "version_not_published" }); });
  it("wrong kind/schema", () => { const c = clone(); c.kind = "something-else"; expect(parseAtlasIndex(c).ok).toBe(false); expect(parseAtlasIndex(null).ok).toBe(false); });
  it("an unknown future category degrades to 'other' instead of failing the catalog", () => {
    const c = clone(); c.maps[0].category = "garrison"; const r = parseAtlasIndex(c);
    expect(r.ok && r.index.maps[0]!.category).toBe("other");
  });
});

describe("catalog loader: CDN with verified-snapshot fallback", () => {
  const ok = (body: unknown = snapshot, extra: Partial<ResponseInit> = {}) => new Response(JSON.stringify(body), { status: 200, ...extra });

  it("only builds the fetch URL from an allow-listed https origin", () => {
    expect(atlasIndexUrl(CDN)).toBe(`${CDN}/atlas/index.json`);
    for (const bad of [null, "", "http://azerdex-assets.pages.dev", "https://evil.example", "https://azerdex-assets.pages.dev:8443", "https://u:p@azerdex-assets.pages.dev", "/maps"]) expect(atlasIndexUrl(bad)).toBeNull();
  });
  it("no CDN configured: snapshot, no request", async () => {
    const f = vi.fn();
    const c = await createAtlasCatalogLoader({ base: null, snapshot, fetchImpl: f as unknown as typeof fetch })();
    expect(c.source).toBe("snapshot");
    expect(f).not.toHaveBeenCalled();
  });
  it("uses the CDN catalog when valid, and caches it for the TTL", async () => {
    let t = 0;
    const f = vi.fn(async (...args: [string, RequestInit?]) => (void args, ok()));
    const load = createAtlasCatalogLoader({ base: CDN, snapshot, fetchImpl: f as unknown as typeof fetch, now: () => t, ttlMs: 1000 });
    expect((await load()).source).toBe("cdn");
    await load(); await load();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]![1]).toMatchObject({ redirect: "error", credentials: "omit" });
    t = 2000; await load();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("shares one in-flight request between concurrent callers", async () => {
    const f = vi.fn(async () => ok());
    const load = createAtlasCatalogLoader({ base: CDN, snapshot, fetchImpl: f as unknown as typeof fetch });
    await Promise.all([load(), load(), load(), load()]);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["network error", () => Promise.reject(new Error("boom"))],
    ["HTTP 500", async () => new Response("x", { status: 500 })],
    ["invalid JSON", async () => new Response("<html>", { status: 200 })],
    ["schema violation", async () => ok({ kind: "azerdex-atlas-index", schemaVersion: 1, maps: [] })],
    ["oversized", async () => ok(snapshot, { headers: { "content-length": String(50 * 1024 * 1024) } })],
  ])("falls back to the snapshot on %s (never throws)", async (_n, impl) => {
    const c = await createAtlasCatalogLoader({ base: CDN, snapshot, fetchImpl: impl as unknown as typeof fetch })();
    expect(c.source).toBe("snapshot");
    expect(c.maps).toHaveLength(60);
  });
  it("aborts a slow CDN after the timeout and serves the snapshot", async () => {
    const slow = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const c = await createAtlasCatalogLoader({ base: CDN, snapshot, fetchImpl: slow, timeoutMs: 40 })();
    expect(c.source).toBe("snapshot");
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("backs off after a failure instead of retrying on every page, and keeps the last good catalog while the CDN fails (stale-if-error)", async () => {
    let t = 0; let fail = false;
    const f = vi.fn(async () => (fail ? new Response("x", { status: 503 }) : ok()));
    const load = createAtlasCatalogLoader({ base: CDN, snapshot, fetchImpl: f as unknown as typeof fetch, now: () => t, ttlMs: 100, failureBackoffMs: 1000 });
    expect((await load()).source).toBe("cdn");
    fail = true; t = 500;
    expect((await load()).source).toBe("cdn"); // stale-if-error
    expect(f).toHaveBeenCalledTimes(2);
    t = 600; await load(); await load();
    expect(f).toHaveBeenCalledTimes(2); // inside the backoff window
  });
  it("refuses a bundled snapshot that is itself invalid (build-time guard)", () => {
    expect(() => createAtlasCatalogLoader({ base: null, snapshot: { kind: "nope" } })).toThrow(/snapshot is invalid/);
  });
});

describe("zone catalog (ordinary zone directory)", () => {
  const catalog = createAtlasCatalogLoader({ base: null, snapshot });
  const observed: ZoneSummary[] = [
    { mapId: 1420, zoneName: "Tirisfal Glades", observations: 100, sourceCount: 4, itemCount: 9 },
    { mapId: 9999, zoneName: "Some Dungeon Floor", observations: 7, sourceCount: 1, itemCount: 2 },
    { mapId: 947, zoneName: "Azeroth", observations: 3, sourceCount: 1, itemCount: 1 },
  ];
  it("lists exactly the 45 zones and 6 cities; battlegrounds/instances, continents and the world map stay out", async () => {
    const cat = await catalog();
    const e = buildZoneEntries(cat, []);
    expect(e).toHaveLength(51);
    expect(e.filter((x) => x.category === "zone")).toHaveLength(45);
    expect(e.filter((x) => x.category === "city").map((x) => x.name).sort()).toEqual(["Darnassus", "Ironforge", "Orgrimmar", "Stormwind City", "Thunder Bluff", "Undercity"]);
    for (const id of [947, 1414, 1415, 1463, 1464, 1459, 1460, 1461, 2524]) expect(findDirectoryEntry(e, id)).toBeUndefined();
  });
  it("a zone without published data is present with an explicit empty state (observed === null), never a fabricated 0", async () => {
    const e = buildZoneEntries(await catalog(), observed);
    const durotar = findDirectoryEntry(e, 1411)!;
    expect(durotar.observed).toBeNull();
    expect(findDirectoryEntry(e, 1420)!.observed).toEqual({ observations: 100, sourceCount: 4, itemCount: 9 });
    expect(durotar.artwork).toBe("available");
    expect(durotar.latestVersion).toBe("v1");
    expect(findDirectoryEntry(e, 1420)!.latestVersion).toBe("v2");
  });
  it("duplicate names are disambiguated by uiMapId and never collide in routing", async () => {
    const e = buildZoneEntries(await catalog(), []);
    const z = e.filter((x) => x.name === "Zephras Isle");
    expect(z.map((x) => x.uiMapId).sort()).toEqual([2521, 2665]);
    expect(z.every((x) => x.ambiguousName)).toBe(true);
    expect(z.find((x) => x.uiMapId === 2665)!.hasFullReveal).toBe(false);
    expect(new Set(e.map((x) => x.uiMapId)).size).toBe(51);
  });
  it("groups by VERIFIED continent only (parent must itself be a continent map)", async () => {
    const e = buildZoneEntries(await catalog(), []);
    const g = groupByContinent(e);
    expect(g.map((x) => [x.label, x.entries.length])).toEqual([["Eastern Kingdoms", 26], ["Kalimdor", 23], ["Other maps (no verified continent)", 2]]);
    expect(g.at(-1)!.entries.map((x) => x.uiMapId).sort()).toEqual([2521, 2665]); // parent is the world map / none: not guessed
    expect(findDirectoryEntry(e, 1453)).toMatchObject({ continentName: "Eastern Kingdoms", category: "city" });
  });
  it("observed maps the atlas does not list as zones/cities stay visible", async () => {
    const out = observedOutsideCatalog(await catalog(), observed);
    expect(out.map((z) => z.mapId).sort()).toEqual([947, 9999]);
  });
  it("artwork needs availability + published version + image; otherwise it is unavailable (no substitution)", async () => {
    const cat = await catalog();
    const m = { ...cat.byId.get(1411)!, image: null };
    expect(artworkOf(m)).toBeNull();
    expect(artworkOf({ ...cat.byId.get(1411)!, availability: "no-artwork" })).toBeNull();
    expect(artworkOf(cat.byId.get(1411)!)).toMatchObject({ version: "v1" });
  });
});
