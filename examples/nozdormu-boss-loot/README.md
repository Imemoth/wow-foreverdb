# Nozdormu boss-loot adapter — independent proof of concept (#13)

**Status: experimental, not an externally supported API integration, data-use licence, or permission to redistribute.** Nozdormu's repository is unchanged. No Supabase roles, secrets, migrations, endpoints, or production deployment are touched.

## Contract verified against the AzerDex `release` branch (2026-10-27)

- Route: `web/src/app/api/v1/source/[type]/[id]/route.ts` calls `data().source("creature", id)` and returns `envelope(d)` or HTTP 404.
- Exact response DTO: `web/src/lib/data/types.ts`: `{ dataset, publicationId, publishedAt, data: { type, id, variants, zones, locations } }` where `variants[]` contains `level`, `name`, `displayKind`, `totalObservations`, `buckets[]` and `drops[]` with nested `source` and `item`, `lootKind`, `drops`, `quantity`, `observations`, nullable `rate` and Wilson bounds, `confidence`, and `dominated`.
- `docs/web/api-contract.md`: 200 cache `public, max-age=60, s-maxage=300, stale-while-revalidate=600`; 4xx/5xx `no-store`; API detail default 120/IP/min; at most 300 drop rows **per source variant** in the fixture adapter. A 300-row result could be truncated.
- Real boss data **not verified** here. A publicly reachable API route does not guarantee any dungeon boss is present in the active published dataset. HTTP 404 means that particular creature ID was not published; a 200 with zero `mob` drops means there is no observed mob-loot evidence in this response. These are distinct cases.

## Run a completely synthetic, no-network example

Requires Node.js 24+; no install, tokens, credentials, package changes, or database access.

```bash
node examples/nozdormu-boss-loot/demo.ts
```

The example prints the exact attempted `GET` URL, a normalized two-level snapshot, the Nozdormu-shaped `{ name, loot: [{ itemId, name }] }` result, and illustrative 404/429 handling. The JSON fixture is explicitly **synthetic**, including its fake publication metadata and invented boss/item IDs. Its `dataset: "published"` flag is a **contract simulation only**, not an assertion about real data. A real API response with `dataset: "synthetic-sample"` is refused as usable public evidence.

## Optional single-ID live availability probe (read-only)

First obtain a **verified Forever creature ID for a known dungeon boss** from a trusted in-game database or manually maintained Nozdormu mapping. Boss names alone are insufficient to identify the AzerDex source, and a successful response is not proof that a creature is a boss.

```bash
node examples/nozdormu-boss-loot/demo.ts --live <known-creature-id>
```

Interpret the result: `found` plus `coverage: "mob-loot-observed"` means **this ID has published mob-loot observations**, not that the dungeon's boss catalog is complete; `found` plus `no-mob-loot-observed` means no relevant observations; `not-published` means 404; `synthetic-dataset` is unusable; `rate-limited` includes `retryAfterSeconds`; and `invalid-response`, `network-error`, or `upstream-error` are failures, not evidence of missing loot. Record `publication.id` and `publication.publishedAt` whenever using a result. Verify `possiblyTruncated` before assuming completeness.

## Integrating without changing Nozdormu

```ts
import { createBossLootClient, toNozdormuBoss } from "./adapter.ts";

// Example ID is invented. Actual integrations must maintain a trusted boss -> creatureId map.
const client = createBossLootClient();
const result = await client.get(999001);
if (result.kind === "found" && result.snapshot.coverage === "mob-loot-observed") {
  const boss = toNozdormuBoss(result.snapshot, "Known Boss Name");
  // boss has the same shape as Nozdormu's Boss interface (name + itemId/name loot list).
  // Persist only if the project owner has separately authorized the intended data use.
}
```

The adapter is dependency-free, has a **hard-coded HTTPS AzerDex public source URL**, issues only GET requests, uses per-instance 1-second request spacing (at most 60/min in one process), coalesces concurrent same-ID requests, caches only valid 200/published responses for **at most 60 seconds** (respecting `max-age` / `Age`), and honors 429 `Retry-After` with an in-memory cooldown (no retry storm). Cross-instance/IP budget remains the caller's responsibility. No auto-polling, no database writes or private data access.

**Intentional limits:** source variants remain separate by level, including level `0` (historical unknown); only `lootKind: "mob"` becomes boss loot, not skinning/other modes; null rates remain null; no cross-level rate is computed. The Nozdormu view de-duplicates items by ID across levels and intentionally omits rates, matching its existing `/dungeon` UI. Names/encounter order, item scanning, and boss-ID mapping remain Nozdormu concerns. No promise of API permanence, completeness, assistance, uptime, refresh frequency, licence, or production usage permission.

## Automated checks

`examples/nozdormu-boss-loot/adapter.test.mjs` runs with Node 24+ without an install. `web/tests/unit/nozdormu-boss-loot.test.ts` additionally runs in the repository's existing Vitest suite and CI. The suites test source shape, synthetic transformation, level separation, 404, 429 and cooldown, cache, malformed data, network/unavailable responses, and request throttling without making any live HTTP requests.

```bash
node --test examples/nozdormu-boss-loot/adapter.test.mjs
cd web && npm ci && npm test -- nozdormu-boss-loot.test.ts
```

**Go/no-go for Andy:** current read-only **transport and transformation are feasible**, but availability of the needed published dungeonboss creature IDs is unverified. This adapter is an internal technical PoC and does not grant data reuse rights or external integration stability. No merge or deployment until separately approved.
