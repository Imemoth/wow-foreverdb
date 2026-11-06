// Standalone, zero-install local smoke suite. The CI Vitest suite adds exhaustive cases.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createBossLootClient, toNozdormuBoss } from "./adapter.ts";

const source = JSON.parse(readFileSync(new URL("./fixtures/synthetic-boss.json", import.meta.url), "utf8")).response;
const fixture = () => structuredClone(source);
const ok = (value, cache = "public, max-age=60, s-maxage=300, stale-while-revalidate=600") =>
  new Response(JSON.stringify(value), { status: 200, headers: { "Cache-Control": cache } });
const timer = () => {
  let now = 0;
  return { now: () => now, advance: ms => { now += ms; }, sleep: async ms => { now += ms; } };
};
const client = (fetchImpl, time = timer()) => ({ api: createBossLootClient({ fetchImpl, now: time.now, sleep: time.sleep }), time });

test("request, exact shape, separate levels, filtered skinning, Nozdormu deduplication", async () => {
  const requests = [];
  const { api } = client(async (url, init) => { requests.push([String(url), init.method]); return ok(fixture()); });
  const result = await api.get(999001);
  assert.deepEqual(requests, [["https://azerdex.com/api/v1/source/creature/999001", "GET"]]);
  assert.equal(result.kind, "found");
  assert.deepEqual(result.snapshot.levels.map(x => [x.level, x.mobObservations, x.items.length]), [[60, 100, 2], [61, 8, 1]]);
  assert.equal(result.snapshot.levels[1].items[0].observedRate, null);
  assert.deepEqual(toNozdormuBoss(result.snapshot, "Mapped Boss"), {
    name: "Mapped Boss", loot: [
      { itemId: 99001, name: "Imaginary Training Blade" },
      { itemId: 99002, name: "Imaginary Copper Sigil" },
    ],
  });
});

test("404 is distinct and not cached", async () => {
  let calls = 0;
  const { api } = client(async () => { calls++; return new Response("{}", { status: 404 }); });
  assert.deepEqual(await api.get(999001), { kind: "not-published", creatureId: 999001 });
  assert.deepEqual(await api.get(999001), { kind: "not-published", creatureId: 999001 });
  assert.equal(calls, 2);
});

test("429 retry-after pauses subsequent requests without retrying", async () => {
  let calls = 0;
  const { api } = client(async () => { calls++; return new Response("{}", { status: 429, headers: { "Retry-After": "15" } }); });
  assert.deepEqual(await api.get(999001), { kind: "rate-limited", creatureId: 999001, retryAfterSeconds: 15 });
  assert.deepEqual(await api.get(999002), { kind: "rate-limited", creatureId: 999002, retryAfterSeconds: 15 });
  assert.equal(calls, 1);
});

test("valid 200 cached 60 seconds but no longer", async () => {
  let calls = 0;
  const time = timer();
  const { api } = client(async () => { calls++; return ok(fixture()); }, time);
  await api.get(999001);
  time.advance(59_999);
  assert.equal((await api.get(999001)).fromCache, true);
  assert.equal(calls, 1);
  time.advance(1);
  assert.equal((await api.get(999001)).fromCache, false);
  assert.equal(calls, 2);
});

test("unknown publication, invalid ID, and source mismatch do not appear as loot", async () => {
  const f = fixture();
  f.data.variants[0].drops[0].observations = 1000;
  const result = await client(async () => ok(f)).api.get(999001);
  assert.equal(result.kind, "invalid-response");
  assert.equal((await client(async () => ok({ ...fixture(), dataset: "synthetic-sample" })).api.get(999001)).kind, "synthetic-dataset");
  await assert.rejects(() => client(async () => ok(fixture())).api.get(0), RangeError);
});

test("many queued IDs stay at most one GET/s in a single instance", async () => {
  const t = timer();
  const requestTimes = [];
  const { api } = client(async (url) => {
    requestTimes.push(t.now());
    const f = fixture();
    f.data.id = Number(String(url).split("/").at(-1));
    for (const level of f.data.variants) for (const drop of level.drops) drop.source.id = f.data.id;
    return ok(f);
  }, t);
  const results = await Promise.all([api.get(999001), api.get(999002), api.get(999003)]);
  assert.deepEqual(results.map(r => r.kind), ["found", "found", "found"]);
  assert.deepEqual(requestTimes, [0, 1000, 2000]);
});
