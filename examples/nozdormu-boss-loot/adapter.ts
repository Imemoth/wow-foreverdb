/**
 * Read-only, dependency-free proof of concept for ForeverDB issue #13.
 * Contract source: web/src/lib/data/types.ts and web/src/app/api/v1/source/[type]/[id]/route.ts
 * on the AzerDex release branch (2026-10-27). Not a public SDK or a licence grant.
 */

const SOURCE_BASE = "https://azerdex.com/api/v1/source/creature/";
const MAX_CREATURE_ID = 999_999_999;
const CLIENT_CACHE_MS = 60_000; // API Cache-Control max-age=60 (not s-maxage=300).
const MIN_REQUEST_SPACING_MS = 1_000; // <=60 requests/min per instance, below API's 120/IP/min.
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 300;

export interface Publication {
  readonly id: number;
  readonly publishedAt: string;
}

export interface ObservedLoot {
  readonly itemId: number;
  readonly name: string;
  readonly drops: number;
  readonly quantity: number;
  /** Denominator for THIS creature level and loot kind, not total observations across kinds. */
  readonly observations: number;
  /** Observed rate, never a guaranteed drop chance. Null means insufficient evidence. */
  readonly observedRate: number | null;
  readonly rateLower: number | null;
  readonly rateUpper: number | null;
  readonly confidence: "insufficient" | "low" | "medium" | "high";
  readonly dominated: boolean;
}

export interface LevelLoot {
  readonly level: number; // 0 means the historical unknown-level bucket.
  readonly sourceName: string;
  readonly mobObservations: number | null;
  readonly items: readonly ObservedLoot[];
}

export interface BossLootSnapshot {
  readonly creatureId: number;
  readonly publication: Publication;
  readonly coverage: "mob-loot-observed" | "no-mob-loot-observed";
  readonly levels: readonly LevelLoot[];
  /** A 300-drop cap applies per variant. Reaching it does not prove completeness. */
  readonly possiblyTruncated: boolean;
}

export type LookupResult =
  | { readonly kind: "found"; readonly snapshot: BossLootSnapshot; readonly fromCache: boolean }
  | { readonly kind: "not-published"; readonly creatureId: number }
  | { readonly kind: "synthetic-dataset"; readonly creatureId: number }
  | { readonly kind: "rate-limited"; readonly creatureId: number; readonly retryAfterSeconds: number }
  | { readonly kind: "upstream-error"; readonly creatureId: number; readonly httpStatus: number }
  | { readonly kind: "invalid-response"; readonly creatureId: number; readonly reason: string }
  | { readonly kind: "network-error"; readonly creatureId: number; readonly reason: string };

/** The actual item-list boundary used by Nozdormu's /dungeon view. */
export interface NozdormuBoss {
  readonly name: string;
  readonly loot: readonly { readonly itemId: number; readonly name: string }[];
}

export interface ClientOptions {
  /** Supply a stub in tests. The production origin cannot be overridden. */
  readonly fetchImpl?: typeof fetch;
  /** Clock and sleep hooks make throttling/caching testable without real waiting. */
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => natural(value) && value > 0;
const label = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const rate = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
const confidence = (value: unknown): value is ObservedLoot["confidence"] =>
  value === "insufficient" || value === "low" || value === "medium" || value === "high";

class ContractError extends Error {}

function requireShape(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ContractError(message);
}

/** Validate only fields actually consumed, but require the documented outer structure. */
function parsePublishedSource(body: unknown, requestedId: number): BossLootSnapshot | "synthetic" {
  requireShape(record(body), "envelope must be an object");
  requireShape(body.dataset === "published" || body.dataset === "synthetic-sample", "unknown dataset mode");
  if (body.dataset === "synthetic-sample") return "synthetic";
  requireShape(positive(body.publicationId), "published data needs a positive publicationId");
  requireShape(
    typeof body.publishedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.publishedAt)
      && Number.isFinite(Date.parse(body.publishedAt)),
    "published data needs an ISO publishedAt",
  );
  const publication: Publication = { id: body.publicationId, publishedAt: body.publishedAt };
  const data = body.data;
  requireShape(record(data) && data.type === "creature" && data.id === requestedId, "wrong creature identity");
  requireShape(Array.isArray(data.variants) && data.variants.length > 0, "variants array missing or empty");
  requireShape(Array.isArray(data.zones) && Array.isArray(data.locations), "zones/locations arrays missing");
  const levels: LevelLoot[] = [];
  let possiblyTruncated = false;
  const seenLevels = new Set<number>();

  for (const variant of data.variants) {
    requireShape(record(variant), "variant must be an object");
    requireShape(natural(variant.level) && variant.level <= 255 && !seenLevels.has(variant.level), "invalid or duplicate source level");
    seenLevels.add(variant.level);
    requireShape(label(variant.name), "variant name missing");
    requireShape(variant.displayKind === "creature", "variant display kind is not creature");
    requireShape(natural(variant.totalObservations), "variant observation count invalid");
    requireShape(Array.isArray(variant.buckets) && Array.isArray(variant.drops), "buckets/drops arrays missing");
    requireShape(variant.drops.length <= 300, "more than 300 drop rows for one variant");
    if (variant.drops.length === 300) possiblyTruncated = true;

    let mobObservations: number | null = null;
    for (const bucket of variant.buckets) {
      requireShape(record(bucket) && label(bucket.lootKind) && natural(bucket.observations)
        && confidence(bucket.confidence), "invalid bucket");
      if (bucket.lootKind === "mob") {
        requireShape(mobObservations === null, "duplicate mob bucket");
        mobObservations = bucket.observations;
      }
    }

    const items: ObservedLoot[] = [];
    const seenItemIds = new Set<number>();
    for (const drop of variant.drops) {
      requireShape(record(drop) && label(drop.lootKind), "invalid drop row");
      if (drop.lootKind !== "mob") continue; // Exclude skinning and every other loot method.
      requireShape(record(drop.source) && drop.source.type === "creature"
        && drop.source.id === requestedId && drop.source.level === variant.level
        && drop.source.displayKind === "creature" && label(drop.source.name), "drop source identity mismatch");
      requireShape(record(drop.item) && positive(drop.item.id) && label(drop.item.name), "invalid item identity");
      requireShape(natural(drop.drops) && natural(drop.quantity) && natural(drop.observations), "invalid drop counts");
      requireShape(rate(drop.rate) && rate(drop.rateLower) && rate(drop.rateUpper), "invalid observed rate/bounds");
      requireShape(confidence(drop.confidence) && typeof drop.dominated === "boolean", "invalid confidence/dominance");
      requireShape(!seenItemIds.has(drop.item.id), "duplicate mob item in one level");
      seenItemIds.add(drop.item.id);
      requireShape(mobObservations !== null && mobObservations === drop.observations,
        "drop denominator differs from mob bucket observations");
      items.push({
        itemId: drop.item.id,
        name: drop.item.name,
        drops: drop.drops,
        quantity: drop.quantity,
        observations: drop.observations,
        observedRate: drop.rate,
        rateLower: drop.rateLower,
        rateUpper: drop.rateUpper,
        confidence: drop.confidence,
        dominated: drop.dominated,
      });
    }
    levels.push({ level: variant.level, sourceName: variant.name, mobObservations, items });
  }
  levels.sort((a, b) => a.level - b.level);
  return {
    creatureId: requestedId,
    publication,
    coverage: levels.some((level) => level.items.length > 0) ? "mob-loot-observed" : "no-mob-loot-observed",
    levels,
    possiblyTruncated,
  };
}

function retryAfter(response: Response, now: number): number {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = /^\d+$/.test(value) ? Number(value)
    : Number.isFinite(Date.parse(value)) ? Math.ceil((Date.parse(value) - now) / 1000)
      : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Number.isFinite(seconds) ? seconds : DEFAULT_RETRY_AFTER_SECONDS));
}

function cacheDuration(response: Response): number {
  const header = response.headers.get("Cache-Control") ?? "";
  if (/\b(no-store|private)\b/i.test(header)) return 0;
  const match = /(?:^|,)\s*max-age=(\d+)(?:,|$)/i.exec(header);
  const maxAge = match ? Number(match[1]) * 1000 : CLIENT_CACHE_MS;
  const age = Number(response.headers.get("Age") ?? "0") * 1000;
  return Math.max(0, Math.min(CLIENT_CACHE_MS, maxAge - (Number.isFinite(age) ? age : 0)));
}

/** In-process per-client rate limiting and 200-only caching; no background polling or retries. */
export function createBossLootClient(options: ClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<number, { until: number; snapshot: BossLootSnapshot }>();
  const inFlight = new Map<number, Promise<LookupResult>>();
  let queue: Promise<void> = Promise.resolve();
  let nextRequestAt = 0;
  let cooldownUntil = 0;

  async function fetchOne(creatureId: number): Promise<LookupResult> {
    // The queue serializes all network attempts within this client instance.
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (now() < cooldownUntil) {
        return { kind: "rate-limited", creatureId, retryAfterSeconds: Math.max(1, Math.ceil((cooldownUntil - now()) / 1000)) };
      }
      const wait = Math.max(0, nextRequestAt - now());
      if (wait > 0) await sleep(wait);
      nextRequestAt = now() + MIN_REQUEST_SPACING_MS;
      let response: Response;
      try {
        response = await fetchImpl(`${SOURCE_BASE}${creatureId}`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
          redirect: "error", // Reject redirects to untrusted origins.
        });
      } catch {
        return { kind: "network-error", creatureId, reason: "fetch failed or timed out" };
      }
      if (response.status === 404) return { kind: "not-published", creatureId };
      if (response.status === 429) {
        const seconds = retryAfter(response, now());
        cooldownUntil = now() + seconds * 1000;
        return { kind: "rate-limited", creatureId, retryAfterSeconds: seconds };
      }
      if (!response.ok) return { kind: "upstream-error", creatureId, httpStatus: response.status };
      let body: unknown;
      try { body = await response.json(); } catch {
        return { kind: "invalid-response", creatureId, reason: "not valid JSON" };
      }
      let parsed: BossLootSnapshot | "synthetic";
      try { parsed = parsePublishedSource(body, creatureId); } catch (error) {
        return { kind: "invalid-response", creatureId, reason: error instanceof ContractError ? error.message : "unexpected payload" };
      }
      if (parsed === "synthetic") return { kind: "synthetic-dataset", creatureId };
      const duration = cacheDuration(response);
      if (duration > 0) cache.set(creatureId, { until: now() + duration, snapshot: parsed });
      return { kind: "found", snapshot: parsed, fromCache: false };
    } finally { release(); }
  }

  return {
    async get(creatureId: number): Promise<LookupResult> {
      if (!positive(creatureId) || creatureId > MAX_CREATURE_ID) throw new RangeError("creatureId must be canonical 1..999999999");
      const cached = cache.get(creatureId);
      if (cached && cached.until > now()) {
        return { kind: "found", snapshot: cached.snapshot, fromCache: true };
      }
      const pending = inFlight.get(creatureId);
      if (pending) return pending;
      const task = fetchOne(creatureId);
      inFlight.set(creatureId, task);
      try { return await task; } finally { inFlight.delete(creatureId); }
    },
  };
}

/**
 * Nozdormu currently stores boss name + unique item IDs, with no drop rates.
 * Boss identity and encounter ordering MUST come from the bot's own trusted mapping.
 * Never invent a cross-level rate: levels retain separate denominators in the snapshot.
 */
export function toNozdormuBoss(snapshot: BossLootSnapshot, bossName: string): NozdormuBoss {
  if (!label(bossName)) throw new TypeError("a known boss name is required");
  const unique = new Map<number, string>();
  for (const level of snapshot.levels) {
    for (const item of level.items) if (!unique.has(item.itemId)) unique.set(item.itemId, item.name);
  }
  return {
    name: bossName,
    loot: [...unique.entries()].sort(([a], [b]) => a - b).map(([itemId, name]) => ({ itemId, name })),
  };
}
