/** Node 24+ can run this TS file directly: node examples/nozdormu-boss-loot/demo.ts */
import { readFileSync } from "node:fs";
import { createBossLootClient, toNozdormuBoss } from "./adapter.ts";

const live = process.argv[2] === "--live";
const raw = JSON.parse(readFileSync(new URL("./fixtures/synthetic-boss.json", import.meta.url), "utf8"));

if (!live) {
  console.log(raw._notice);
  const mockFetch: typeof fetch = async (url, init) => {
    console.log("GET", String(url), "method:", init?.method);
    return new Response(JSON.stringify(raw.response), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" },
    });
  };
  const client = createBossLootClient({ fetchImpl: mockFetch });
  const result = await client.get(999001);
  console.log("lookup:", JSON.stringify(result, null, 2));
  if (result.kind === "found") {
    console.log("Nozdormu /dungeon boss:", JSON.stringify(toNozdormuBoss(result.snapshot, "Synthetic Test Sentinel"), null, 2));
  }
  const missing = await createBossLootClient({ fetchImpl: async () => new Response('{"error":"not_found"}', { status: 404 }) }).get(999002);
  console.log("404 example:", missing);
  const limited = await createBossLootClient({ fetchImpl: async () => new Response('{"error":"rate_limited"}', { status: 429, headers: { "Retry-After": "15" } }) }).get(999003);
  console.log("429 example:", limited);
} else {
  // Explicit opt-in, one read-only production API call to an already-known creature ID.
  const id = Number(process.argv[3]);
  if (!Number.isSafeInteger(id) || id < 1 || id > 999_999_999) {
    throw new Error("Usage: node examples/nozdormu-boss-loot/demo.ts --live <known-creature-id>");
  }
  const result = await createBossLootClient().get(id);
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === "found") {
    console.log("Actual mob loot rows:", result.snapshot.levels.reduce((n, level) => n + level.items.length, 0));
    console.log("Do not infer dungeon-boss status from this API: independently map creature IDs to named bosses.");
  }
}
