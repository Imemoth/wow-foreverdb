import { describe, expect, it } from "vitest";
import fixture from "../../../examples/nozdormu-boss-loot/fixtures/synthetic-boss.json";
import { createBossLootClient, toNozdormuBoss } from "../../../examples/nozdormu-boss-loot/adapter";

// Invented ID, item names, and publication ID. This never contacts a real API.
const creatureId = 999001;
type FixtureResponse = typeof fixture.response;
type FixtureDrop = FixtureResponse["data"]["variants"][number]["drops"][number];
type MutableVariant = Omit<FixtureResponse["data"]["variants"][number], "drops"> & { drops: FixtureDrop[] };
type MutableResponse = Omit<FixtureResponse, "data"> & {
  data: Omit<FixtureResponse["data"], "variants"> & { variants: MutableVariant[] };
};
const payload = (): MutableResponse => structuredClone(fixture.response) as MutableResponse;
const ok = (body: unknown, cacheControl = "public, max-age=60, s-maxage=300, stale-while-revalidate=600") =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Cache-Control": cacheControl } });
const clock = () => {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    advance: (milliseconds: number) => { time += milliseconds; },
    sleep: async (milliseconds: number) => { waits.push(milliseconds); time += milliseconds; },
    waits,
  };
};

const liveLikeClient = (fetchImpl: typeof fetch, timer = clock()) =>
  { return { client: createBossLootClient({ fetchImpl, now: timer.now, sleep: timer.sleep }), timer }; };

describe("Nozdormu external boss-loot PoC (synthetic contract tests)", () => {
  it("uses only the existing canonical GET endpoint and maps exact per-level mob drops", async () => {
    let requestUrl = "";
    let method = "";
    let redirect = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      method = init?.method ?? "";
      redirect = init?.redirect ?? "";
      return ok(payload());
    };
    const { client } = liveLikeClient(fetchImpl);
    const result = await client.get(creatureId);
    expect(requestUrl).toBe("https://azerdex.com/api/v1/source/creature/999001");
    expect(method).toBe("GET");
    expect(redirect).toBe("error");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.fromCache).toBe(false);
    expect(result.snapshot.publication).toEqual({ id: 42, publishedAt: "2026-10-26T12:00:00.000Z" });
    expect(result.snapshot.coverage).toBe("mob-loot-observed");
    expect(result.snapshot.levels.map((level) => [level.level, level.mobObservations, level.items.length])).toEqual([
      [60, 100, 2], [61, 8, 1],
    ]);
    expect(result.snapshot.levels[0]?.items.map((item) => item.itemId)).toEqual([99001, 99002]);
    expect(result.snapshot.levels[0]?.items[0]?.observedRate).toBe(0.12);
    expect(result.snapshot.levels[1]?.items[0]?.observedRate).toBeNull();
    expect(result.snapshot.levels[1]?.items[0]?.confidence).toBe("insufficient");
    expect(result.snapshot.possiblyTruncated).toBe(false);
    expect(toNozdormuBoss(result.snapshot, "Trusted Boss Name")).toEqual({
      name: "Trusted Boss Name",
      loot: [
        { itemId: 99001, name: "Imaginary Training Blade" },
        { itemId: 99002, name: "Imaginary Copper Sigil" },
      ],
    });
  });

  it("caches only successful published 200 results for <=60 seconds", async () => {
    let calls = 0;
    const timer = clock();
    const { client } = liveLikeClient(async () => { calls++; return ok(payload()); }, timer);
    expect((await client.get(creatureId)).kind).toBe("found");
    timer.advance(59_999);
    const cached = await client.get(creatureId);
    expect(cached.kind).toBe("found");
    if (cached.kind === "found") expect(cached.fromCache).toBe(true);
    expect(calls).toBe(1);
    timer.advance(1);
    const fresh = await client.get(creatureId);
    expect(fresh.kind).toBe("found");
    if (fresh.kind === "found") expect(fresh.fromCache).toBe(false);
    expect(calls).toBe(2);
  });

  it("honors 200 max-age, Age and no-store rather than CDN s-maxage", async () => {
    let calls = 0;
    const timer = clock();
    const { client } = liveLikeClient(async () => {
      calls++;
      const response = ok(payload(), "public, max-age=5, s-maxage=300");
      response.headers.set("Age", "3");
      return response;
    }, timer);
    await client.get(creatureId);
    timer.advance(1999);
    expect((await client.get(creatureId)).kind).toBe("found");
    expect(calls).toBe(1);
    timer.advance(1);
    await client.get(creatureId);
    expect(calls).toBe(2);
    const timer2 = clock();
    let uncachedCalls = 0;
    const uncached = liveLikeClient(async () => { uncachedCalls++; return ok(payload(), "private, no-store"); }, timer2).client;
    await uncached.get(creatureId);
    await uncached.get(creatureId);
    expect(uncachedCalls).toBe(2);
  });

  it("coalesces concurrent requests for the same creature", async () => {
    let calls = 0;
    const { client } = liveLikeClient(async () => { calls++; return ok(payload()); });
    const results = await Promise.all([client.get(creatureId), client.get(creatureId), client.get(creatureId)]);
    expect(calls).toBe(1);
    expect(results.every((result) => result.kind === "found")).toBe(true);
  });

  it("spaces calls by >=1 second even when IDs differ", async () => {
    const timer = clock();
    const callTimes: number[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      callTimes.push(timer.now());
      const body = payload();
      body.data.id = Number(String(input).split("/").at(-1));
      for (const level of body.data.variants) for (const drop of level.drops) drop.source.id = body.data.id;
      return ok(body);
    };
    const { client } = liveLikeClient(fetchImpl, timer);
    const results = await Promise.all([client.get(999001), client.get(999002), client.get(999003)]);
    expect(results.map((r) => r.kind)).toEqual(["found", "found", "found"]);
    expect(callTimes).toEqual([0, 1000, 2000]);
    expect(timer.waits).toEqual([1000, 1000]);
  });

  it("distinguishes a 404 from a published creature with zero mob-loot rows; never caches 404", async () => {
    let count = 0;
    const { client } = liveLikeClient(async () => { count++; return new Response('{"error":"not_found"}', { status: 404, headers: { "Cache-Control": "no-store" } }); });
    expect(await client.get(creatureId)).toEqual({ kind: "not-published", creatureId });
    expect(await client.get(creatureId)).toEqual({ kind: "not-published", creatureId });
    expect(count).toBe(2);
    const body = payload();
    body.data.variants[0]!.drops = body.data.variants[0]!.drops.filter((row) => row.lootKind !== "mob");
    body.data.variants[1]!.drops = [];
    const noMob = await liveLikeClient(async () => ok(body)).client.get(creatureId);
    expect(noMob.kind).toBe("found");
    if (noMob.kind === "found") {
      expect(noMob.snapshot.coverage).toBe("no-mob-loot-observed");
      expect(toNozdormuBoss(noMob.snapshot, "Known Boss").loot).toEqual([]);
    }
  });

  it("handles 429 Retry-After without automatically retrying, and cools down local requests", async () => {
    const timer = clock();
    let calls = 0;
    const { client } = liveLikeClient(async (input) => {
      calls++;
      if (calls === 1) return new Response('{"error":"rate_limited"}', { status: 429, headers: { "Retry-After": "15" } });
      const body = payload();
      body.data.id = Number(String(input).split("/").at(-1));
      for (const level of body.data.variants) for (const drop of level.drops) drop.source.id = body.data.id;
      return ok(body);
    }, timer);
    expect(await client.get(creatureId)).toEqual({ kind: "rate-limited", creatureId, retryAfterSeconds: 15 });
    expect(await client.get(999002)).toEqual({ kind: "rate-limited", creatureId: 999002, retryAfterSeconds: 15 });
    expect(calls).toBe(1);
    timer.advance(15_000);
    expect((await client.get(999002)).kind).toBe("found");
    expect(calls).toBe(2);
  });

  it("bounds excessive Retry-After and uses a conservative fallback for missing headers", async () => {
    const limited = await liveLikeClient(async () => new Response("", { status: 429, headers: { "Retry-After": "999999" } })).client.get(creatureId);
    expect(limited.kind === "rate-limited" && limited.retryAfterSeconds).toBe(300);
    const missing = await liveLikeClient(async () => new Response("", { status: 429 })).client.get(creatureId);
    expect(missing.kind === "rate-limited" && missing.retryAfterSeconds).toBe(30);
  });

  it("returns typed upstream and network errors instead of treating them as missing loot", async () => {
    const unavailable = await liveLikeClient(async () => new Response("{}", { status: 503 })).client.get(creatureId);
    expect(unavailable).toEqual({ kind: "upstream-error", creatureId, httpStatus: 503 });
    const failed = await liveLikeClient(async () => { throw new Error("offline"); }).client.get(creatureId);
    expect(failed).toEqual({ kind: "network-error", creatureId, reason: "fetch failed or timed out" });
    const invalidJson = await liveLikeClient(async () => new Response("not json", { status: 200 })).client.get(creatureId);
    expect(invalidJson).toEqual({ kind: "invalid-response", creatureId, reason: "not valid JSON" });
  });

  it("rejects synthetic dataset mode even with otherwise valid sample data", async () => {
    const body = payload();
    body.dataset = "synthetic-sample";
    expect(await liveLikeClient(async () => ok(body)).client.get(creatureId)).toEqual({ kind: "synthetic-dataset", creatureId });
  });

  it("rejects incorrect creature identity, publication envelope, drop source and denominator", async () => {
    const variants = [
      (body: ReturnType<typeof payload>) => { body.data.id = 999002; },
      (body: ReturnType<typeof payload>) => { body.publicationId = 0; },
      (body: ReturnType<typeof payload>) => { body.publishedAt = "bad-date"; },
      (body: ReturnType<typeof payload>) => { body.data.variants[0]!.drops[0]!.source.id = 999002; },
      (body: ReturnType<typeof payload>) => { body.data.variants[0]!.drops[0]!.observations = 9; },
      (body: ReturnType<typeof payload>) => { body.data.variants[0]!.drops[0]!.rate = 999; },
    ];
    for (const mutate of variants) {
      const body = payload();
      mutate(body);
      const response = await liveLikeClient(async () => ok(body)).client.get(creatureId);
      expect(response.kind).toBe("invalid-response");
    }
  });

  it("signals possible 300-drop truncation rather than claiming completeness", async () => {
    const body = payload();
    const template = body.data.variants[0]!.drops[0]!;
    body.data.variants[0]!.drops = Array.from({ length: 300 }, (_, index) => ({
      ...template,
      item: { id: 100_000 + index, name: `Synthetic item ${index}` },
    }));
    const result = await liveLikeClient(async () => ok(body)).client.get(creatureId);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.snapshot.possiblyTruncated).toBe(true);
  });

  it("rejects invalid creature IDs without an HTTP request", async () => {
    let calls = 0;
    const { client } = liveLikeClient(async () => { calls++; return ok(payload()); });
    await expect(client.get(0)).rejects.toThrow(RangeError);
    await expect(client.get(-1)).rejects.toThrow(RangeError);
    await expect(client.get(1.5)).rejects.toThrow(RangeError);
    await expect(client.get(1_000_000_000)).rejects.toThrow(RangeError);
    expect(calls).toBe(0);
  });

  it("requires a trusted boss name, never infers boss identity from creature names", async () => {
    const result = await liveLikeClient(async () => ok(payload())).client.get(creatureId);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(() => toNozdormuBoss(result.snapshot, " ")).toThrow(TypeError);
      expect(toNozdormuBoss(result.snapshot, "Independent Dungeon Boss Name").name).toBe("Independent Dungeon Boss Name");
    }
  });
});
