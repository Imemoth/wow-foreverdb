import { describe, expect, it, vi } from "vitest";
import { createHandler, projectReport, sign, CACHE_MS, DEFAULT_SIGNED_PATH, READ_TIMEOUT_MS, WINDOW_SECONDS, type HandlerDeps } from "../../supabase/functions/azerdex-ops-health/handler";
import { parseHealthSnapshot } from "../src/health/contract";
import { runEndpointChecks } from "../src/health/endpoint-check";
import { HttpHealthProvider, signRequest } from "../src/health/http-provider";
import { healthySnapshot, withSource } from "../src/health/mock-provider";

/**
 * Gate C: the protected reporting endpoint (supabase/functions/azerdex-ops-health/handler.ts) against the Ops Bot's REAL signing function,
 * HttpHealthProvider and contract. No database here (the SQL and the end-to-end run live in scripts/ops-health-sql-tests.sh and gate-c-e2e.test.ts).
 */
const SECRET = "s".repeat(40);
const URL_ = "https://project.supabase.co" + DEFAULT_SIGNED_PATH;
const T = Date.UTC(2026, 10, 10, 12, 0, 0);
const report = () => healthySnapshot(T) as unknown as Record<string, unknown>;

function make(over: Partial<HandlerDeps> = {}) {
  const readReport = vi.fn(async () => report());
  let now = T;
  const deps: HandlerDeps = { secret: SECRET, signedPath: DEFAULT_SIGNED_PATH, now: () => now, readReport, ...over };
  return { handle: createHandler(deps), readReport, advance: (ms: number) => { now += ms; }, deps };
}
async function signed(over: { ts?: number; secret?: string; path?: string; method?: string; sig?: string; tsHeader?: string } = {}, method = "GET"): Promise<Request> {
  const ts = over.ts ?? Math.floor(T / 1000);
  const sig = over.sig ?? await signRequest(over.secret ?? SECRET, over.method ?? "GET", over.path ?? DEFAULT_SIGNED_PATH, ts);
  return new Request(URL_, { method, headers: { "x-azerdex-ops-timestamp": over.tsHeader ?? String(ts), "x-azerdex-ops-signature": sig } });
}
const status = async (h: ReturnType<typeof make>, r: Request) => (await h.handle(r)).status;

describe("authentication: one uniform refusal, and nothing is read before it", () => {
  it("accepts exactly what the bot's real signing function produces (shared algorithm)", async () => {
    const h = make();
    expect(await sign(SECRET, "GET", DEFAULT_SIGNED_PATH, 1)).toBe(await signRequest(SECRET, "GET", DEFAULT_SIGNED_PATH, 1));
    expect(await status(h, await signed())).toBe(200);
  });

  it.each([
    ["no headers", () => new Request(URL_)],
    ["missing signature", () => new Request(URL_, { headers: { "x-azerdex-ops-timestamp": String(Math.floor(T / 1000)) } })],
    ["missing timestamp", async () => new Request(URL_, { headers: { "x-azerdex-ops-signature": await signRequest(SECRET, "GET", DEFAULT_SIGNED_PATH, Math.floor(T / 1000)) } })],
  ])("%s -> 401", async (_n, build) => {
    const h = make(); const res = await h.handle(await build());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(h.readReport).not.toHaveBeenCalled();
  });

  it("wrong secret, wrong path (another endpoint's signature), wrong method in the signature -> 401", async () => {
    const h = make();
    expect(await status(h, await signed({ secret: "x".repeat(40) }))).toBe(401);
    expect(await status(h, await signed({ path: "/functions/v1/some-other-function" }))).toBe(401);
    expect(await status(h, await signed({ method: "POST" }))).toBe(401);
    expect(h.readReport).not.toHaveBeenCalled();
  });

  it(`the timestamp window is +-${WINDOW_SECONDS} s: the edge passes, one second beyond fails (replay protection by expiry)`, async () => {
    const h = make(); const base = Math.floor(T / 1000);
    expect(await status(h, await signed({ ts: base - WINDOW_SECONDS }))).toBe(200);
    expect(await status(h, await signed({ ts: base + WINDOW_SECONDS }))).toBe(200);
    expect(await status(h, await signed({ ts: base - WINDOW_SECONDS - 1 }))).toBe(401);
    expect(await status(h, await signed({ ts: base + WINDOW_SECONDS + 1 }))).toBe(401);
  });

  it.each(["abc", "123456789", "12345678901", "1762776000.5", " 1762776000", "-1762776000"])("a malformed timestamp header %j -> 401", async (tsHeader) => {
    const h = make();
    expect(await status(h, await signed({ tsHeader }))).toBe(401);
  });

  it("a malformed signature (uppercase hex, short, long, non-hex) -> 401", async () => {
    const h = make(); const good = await signRequest(SECRET, "GET", DEFAULT_SIGNED_PATH, Math.floor(T / 1000));
    for (const sig of [good.toUpperCase(), good.slice(1), good + "0", "z".repeat(64), ""]) expect(await status(h, await signed({ sig })), sig.slice(0, 8)).toBe(401);
  });

  it("an unset or empty secret refuses everything, even a request signed with the secret the bot holds (fail closed)", async () => {
    for (const secret of [undefined, ""]) {
      const h = make({ secret });
      expect(await status(h, await signed())).toBe(401);
      expect(h.readReport).not.toHaveBeenCalled();
    }
  });

  it("only GET is served: POST, PUT, DELETE and HEAD get 405 with Allow: GET and read nothing", async () => {
    const h = make();
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const res = await h.handle(await signed({}, method));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect(h.readReport).not.toHaveBeenCalled();
  });

  it("the refusal never echoes anything the caller sent", async () => {
    const h = make(); const res = await h.handle(new Request(URL_ + "?x=CANARY-QUERY", { headers: { "x-azerdex-ops-signature": "CANARY-SIG", "x-azerdex-ops-timestamp": "CANARY-TS", authorization: "Bearer CANARY-AUTH" } }));
    const text = await res.text();
    expect(text).toBe('{"error":"unauthorized"}');
    expect(JSON.stringify([...res.headers])).not.toMatch(/CANARY/);
  });
});

describe("the response: contract v1, allow-listed, never cached", () => {
  it("returns 200 with no-store, nosniff and JSON, and the body is accepted by the bot's strict contract", async () => {
    const res = await make().handle(await signed());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(parseHealthSnapshot(await res.json()).ok).toBe(true);
  });

  it("drops every field the contract does not list, at every level (a future G2 field cannot leak)", async () => {
    const raw = report() as Record<string, unknown> & { sources: Array<Record<string, unknown>>; g6: Record<string, unknown> };
    raw.secret = "postgresql://u:p@h/db"; raw.netLast2h = { bad: 1 };
    raw.sources[0]!.recent24h = { title: "WoW Forever post text" }; raw.sources[0]!.lastHttpStatus = 503; raw.sources[0]!.lastOfficialPostAt = "2026-01-01T00:00:00Z";
    raw.g6.command = "select private.azerdex_news_assert_healthy()"; raw.g6.username = "postgres";
    const text = await (await make({ readReport: async () => raw }).handle(await signed())).text();
    expect(text).not.toMatch(/secret|postgresql|netLast2h|recent24h|lastHttpStatus|lastOfficialPostAt|WoW Forever|command|username/);
    expect(parseHealthSnapshot(JSON.parse(text)).ok).toBe(true);
  });

  it("an invalid report is refused with 502 and nothing of it is returned", async () => {
    const base = report() as Record<string, unknown> & { sources: Array<Record<string, unknown>>; g6: Record<string, unknown> };
    const bad: Array<[string, (r: typeof base) => void]> = [
      ["no g6", (r) => { delete (r as Record<string, unknown>).g6; }],
      ["no sources", (r) => { r.sources = []; }],
      ["17 sources", (r) => { r.sources = Array.from({ length: 17 }, (_, i) => ({ ...r.sources[0]!, sourceKey: `s-${i}` })); }],
      ["unknown severity", (r) => { r.sources[0]!.severity = "fatal"; }],
      ["non-integer count", (r) => { r.sources[0]!.consecutiveFailures = 1.5; }],
      ["negative minutes", (r) => { r.sources[0]!.minutesSinceAttempt = -1; }],
      ["code outside the alphabet", (r) => { r.sources[0]!.state = "Has Space"; }],
      ["cause outside the alphabet", (r) => { r.sources[0]!.causes = ["ok", "bad cause!"]; }],
      ["nine causes", (r) => { r.sources[0]!.causes = Array.from({ length: 9 }, (_, i) => `c${i}`); }],
      ["source key with uppercase", (r) => { r.sources[0]!.sourceKey = "Blizzard-US"; }],
      ["non-ISO timestamp", (r) => { r.generatedAt = "yesterday"; }],
      ["wrong schema version", (r) => { r.schemaVersion = 2; }],
      ["wrong job name", (r) => { r.g6.jobName = "azerdex-news-official"; }],
      ["schedule too long", (r) => { r.g6.schedule = "x".repeat(41); }],
      ["unknown run status", (r) => { r.g6.lastRunStatus = "exploded"; }],
      ["present not boolean", (r) => { r.g6.present = "yes"; }],
    ];
    for (const [name, mutate] of bad) {
      const raw = structuredClone(base); mutate(raw);
      const res = await make({ readReport: async () => raw }).handle(await signed());
      expect(res.status, name).toBe(502);
      expect(await res.json(), name).toEqual({ error: "invalid_report" });
    }
    for (const raw of [null, undefined, "text", 42, [], {}]) expect((await make({ readReport: async () => raw }).handle(await signed())).status).toBe(502);
  });

  it("projectReport accepts exactly the same VALUES as the bot's zod contract (single-field mutations agree)", () => {
    const valid = healthySnapshot(T);
    const variants: unknown[] = [
      valid, { ...valid, overall: "critical" }, withSource(valid, "blizzard-bluepost-us", { causes: ["a", "b:c", "d.e", "f-g", "h_i"], minutesSinceAttempt: null, lastAttemptAt: null }),
      withSource(valid, "blizzard-bluepost-us", { lastAttemptAt: "2026-11-10T11:56:00.123456+00:00", lastFetchOkAt: "2026-11-10T11:56:00Z" }),
      { ...valid, g6: { ...valid.g6, present: false, active: false, schedule: null, lastRunAt: null, lastRunStatus: null, lastSucceededAt: null } },
      { ...valid, g6: { ...valid.g6, lastRunStatus: "running" } }, { ...valid, g6: { ...valid.g6, lastRunStatus: "unknown" } },
    ];
    const invalid: unknown[] = [
      withSource(valid, "blizzard-bluepost-us", { severity: "fatal" as never }), withSource(valid, "blizzard-bluepost-us", { state: "Bad State" }),
      withSource(valid, "blizzard-bluepost-us", { consecutiveFailures: -1 }), withSource(valid, "blizzard-bluepost-us", { overdueTopics: 1.2 }),
      withSource(valid, "blizzard-bluepost-us", { minutesSinceAttempt: 10_000_001 }), withSource(valid, "blizzard-bluepost-us", { lastAttemptAt: "2026-11-10 11:56:00" }),
      { ...valid, sources: [] }, { ...valid, generatedAt: "nope" }, { ...valid, schemaVersion: 2 }, { ...valid, g6: { ...valid.g6, lastRunStatus: "exploded" } },
      { ...valid, g6: { ...valid.g6, jobName: "other" } }, { ...valid, g6: { ...valid.g6, schedule: "x".repeat(41) } },
    ];
    for (const v of variants) { expect(parseHealthSnapshot(v).ok, JSON.stringify(v).slice(0, 80)).toBe(true); expect(projectReport(v), "accepted by zod, refused by the handler").not.toBeNull(); }
    for (const v of invalid) { expect(parseHealthSnapshot(v).ok, JSON.stringify(v).slice(0, 80)).toBe(false); expect(projectReport(v), "refused by zod, accepted by the handler").toBeNull(); }
  });
});

describe("unavailable data and bounded execution", () => {
  it("a database error is 503 unavailable with no detail", async () => {
    const h = make({ readReport: async () => { throw new Error("password authentication failed for user azerdex_ops_reporter CANARY-DB"); } });
    const res = await h.handle(await signed());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"error":"unavailable"}');
  });

  it("a database that never answers is cut off at the configured bound with 503 (default bound: 8 s)", async () => {
    expect(READ_TIMEOUT_MS).toBe(8_000);
    const h = make({ readReport: () => new Promise(() => undefined), readTimeoutMs: 40 });
    const started = Date.now();
    const res = await h.handle(await signed());
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it(`a good report is reused for ${CACHE_MS / 1000} s, then read again; concurrent callers share one read`, async () => {
    const h = make();
    await Promise.all(Array.from({ length: 6 }, async () => h.handle(await signed())));
    expect(h.readReport).toHaveBeenCalledTimes(1);
    h.advance(CACHE_MS - 1); await h.handle(await signed({ ts: Math.floor((T + CACHE_MS - 1) / 1000) }));
    expect(h.readReport).toHaveBeenCalledTimes(1);
    h.advance(2); await h.handle(await signed({ ts: Math.floor((T + CACHE_MS + 1) / 1000) }));
    expect(h.readReport).toHaveBeenCalledTimes(2);
  });

  it("a failure is never cached: the next request tries the database again", async () => {
    let fail = true;
    const h = make({ readReport: vi.fn(async () => { if (fail) throw new Error("down"); return report(); }) });
    expect(await status(h, await signed())).toBe(503);
    fail = false;
    expect(await status(h, await signed())).toBe(200);
  });

  it("unauthenticated floods never reach the database", async () => {
    const h = make();
    for (let i = 0; i < 50; i++) await h.handle(new Request(URL_, { headers: { "x-azerdex-ops-signature": "a".repeat(64), "x-azerdex-ops-timestamp": String(Math.floor(T / 1000)) } }));
    expect(h.readReport).not.toHaveBeenCalled();
  });
});

describe("integration with the bot's existing HttpHealthProvider (no interface change)", () => {
  const providerFor = (h: ReturnType<typeof make>, secret = SECRET) =>
    new HttpHealthProvider({ url: URL_, secret, now: () => T, fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => h.handle(new Request(input as string, init))) as typeof fetch });

  it("the provider receives a valid, fresh snapshot from the endpoint", async () => {
    const r = await providerFor(make()).fetchSnapshot();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot.sources.map((s) => s.sourceKey)).toEqual(["blizzard-bluepost-us", "blizzard-bluepost-eu", "blizzard-news-us"]);
  });

  it("wrong secret -> the provider reports `auth` (the bot escalates after 2 polls)", async () => {
    expect(await providerFor(make(), "w".repeat(40)).fetchSnapshot()).toMatchObject({ ok: false, failure: "auth", httpStatus: 401 });
  });

  it("database failure -> `server` (UNKNOWN, escalates after 3 polls); invalid report -> `server` too, never a green snapshot", async () => {
    expect(await providerFor(make({ readReport: async () => { throw new Error("x"); } })).fetchSnapshot()).toMatchObject({ ok: false, failure: "server", httpStatus: 503 });
    expect(await providerFor(make({ readReport: async () => ({ schemaVersion: 1 }) })).fetchSnapshot()).toMatchObject({ ok: false, failure: "server", httpStatus: 502 });
  });

  it("the provider's own signed path must equal the endpoint's configured path: a different path is refused", async () => {
    const h = make({ signedPath: "/functions/v1/azerdex-ops-health-v2" });
    expect(await providerFor(h).fetchSnapshot()).toMatchObject({ ok: false, failure: "auth" });
  });
});

describe("the owner's post-deployment check (scripts/check-health-endpoint.ts)", () => {
  const via = (h: ReturnType<typeof make>) => ((input: RequestInfo | URL, init?: RequestInit) => h.handle(new Request(input as string, init))) as typeof fetch;

  it("passes against a correct endpoint, never prints the secret or the URL, and reads the report exactly once", async () => {
    const h = make();
    const checks = await runEndpointChecks({ url: URL_, secret: SECRET, fetchFn: via(h), now: () => T });
    expect(checks.every((c) => c.pass), JSON.stringify(checks.filter((c) => !c.pass))).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(["an unsigned request is refused", "the body satisfies the bot's strict contract v1"]));
    expect(JSON.stringify(checks)).not.toContain(SECRET);
    expect(JSON.stringify(checks)).not.toContain("project.supabase.co");
    expect(h.readReport).toHaveBeenCalledTimes(1);
  });

  it("FAILS against an endpoint that skips authentication (the check is not a rubber stamp)", async () => {
    const open = (async () => new Response(JSON.stringify(report()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const checks = await runEndpointChecks({ url: URL_, secret: SECRET, fetchFn: open, now: () => T });
    expect(checks.filter((c) => !c.pass).map((c) => c.name)).toEqual(expect.arrayContaining(["an unsigned request is refused", "a request signed with a wrong secret is refused", "a non-GET request is refused"]));
  });

  it("FAILS when the deployed secret differs from the bot's (the signed request is refused)", async () => {
    const checks = await runEndpointChecks({ url: URL_, secret: "q".repeat(40), fetchFn: via(make()), now: () => T });
    expect(checks.find((c) => c.name === "the signed request is accepted")).toMatchObject({ pass: false });
  });
});
