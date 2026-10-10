import { afterAll, describe, expect, it } from "vitest";
import regression from "../fixtures/zone-semantics.projection.json";
import { FixtureAdapter } from "@/lib/data/fixture-adapter";
import { PostgresAdapter } from "@/lib/data/postgres-adapter";
import type { PublicDataAdapter, SearchQuery, ZoneEntityQuery } from "@/lib/data/types";

/**
 * The fixture adapter and the PostgreSQL adapter must give IDENTICAL answers for the
 * zone-semantics regression dataset (same export published through the real worker).
 * Skipped unless PARITY_DATABASE_URL is set (CI: publisher-and-pipeline job).
 */
const url = process.env.PARITY_DATABASE_URL;
const fixture: PublicDataAdapter = new FixtureAdapter(regression as unknown as ConstructorParameters<typeof FixtureAdapter>[0]);
const pg: PublicDataAdapter | null = url ? new PostgresAdapter(url) : null;

/** Timestamps are the same instant but may be formatted differently by JSON producers. */
const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (/At$/.test(k) && typeof x === "string" ? new Date(x).toISOString() : x)));

const sq = (o: Partial<SearchQuery>): SearchQuery => ({ q: "", category: null, zone: null, kind: null, sort: "relevance", page: 1, pageSize: 25, ...o });
const zq = (mapId: number, o: Partial<ZoneEntityQuery> = {}): ZoneEntityQuery => ({ mapId, displayKind: null, lootKind: null, q: "", page: 1, pageSize: 50, ...o });

afterAll(async () => { await (pg as unknown as { pool?: { end(): Promise<void> } } | null)?.pool?.end().catch(() => undefined); });

// Fail open only locally: in CI a missing database URL must be a failure, not a silent skip.
if (!url && process.env.CI) throw new Error("PARITY_DATABASE_URL is required in CI");

describe.skipIf(!url)("fixture <-> PostgreSQL parity (zone semantics regression dataset)", () => {
  const both = async <T>(fn: (a: PublicDataAdapter) => Promise<T>) => [norm(await fn(fixture)), norm(await fn(pg!))] as const;

  it("serves the expected dataset (guards against comparing two empty answers)", async () => {
    const r = await pg!.zoneEntities(zq(1420));
    expect(r.total).toBe(8);
    expect(r.rows.filter((x) => x.entityKind === "item").every((x) => x.observations === null && x.association === "inferred")).toBe(true);
  });

  it.each([1420, 1421])("zone %i summary and detail", async (id) => {
    const [a, b] = await both((d) => d.zone(id));
    expect(b).toEqual(a);
  });

  it("zones list", async () => {
    const [a, b] = await both((d) => d.zones());
    expect(b).toEqual(a);
  });

  it.each([
    [1420, {}], [1421, {}], [1420, { displayKind: "item" }], [1421, { displayKind: "item" }], [1420, { displayKind: "creature" }],
    [1420, { lootKind: "mob" }], [1420, { lootKind: "mining" }], [1420, { lootKind: "fishing" }], [1420, { q: "walker" }], [1421, { q: "scrap" }],
    [1420, { page: 2, pageSize: 50 }], [999, {}],
  ] as [number, Partial<ZoneEntityQuery>][])("zone directory %i %j (rows, order, totals)", async (id, o) => {
    const [a, b] = await both((d) => d.zoneEntities(zq(id, o)));
    expect(b).toEqual(a);
  });

  it.each([9101, 9102, 9103, 9104, 424242])("item %i (zones are inferred, no numeric zone count)", async (id) => {
    const [a, b] = await both((d) => d.item(id));
    expect(b).toEqual(a);
  });

  it.each([["creature", 9001], ["creature", 9002], ["gameobject", 9301], ["fishing", 1420], ["creature", 1]] as const)("source %s %i", async (t, id) => {
    const [a, b] = await both((d) => d.source(t, id));
    expect(b).toEqual(a);
  });

  it.each([
    [{ q: "fixture" }], [{ q: "walker trinket" }], [{ q: "9101" }], [{ zone: 1420, sort: "observations" }], [{ zone: 1421, sort: "observations" }],
    [{ zone: 1421, kind: "mob", sort: "name" }], [{ kind: "mining" }], [{ kind: "fishing" }], [{ category: "creature", zone: 1420 }], [{ category: "item", zone: 1420, sort: "observations" }],
    [{ zone: 1420, page: 9 }],
  ] as Partial<SearchQuery>[][])("search %j (membership, ordering, global observations)", async (o) => {
    const [a, b] = await both((d) => d.search(sq(o as Partial<SearchQuery>)));
    expect(b).toEqual(a);
  });
});
