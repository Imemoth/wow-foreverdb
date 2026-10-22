import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AtlasMap } from "@/lib/maps/atlas/schema";
import { CINEMATIC_ZONE_ARTWORK, resolveZoneArtwork } from "@/lib/maps/zone-artwork";

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
