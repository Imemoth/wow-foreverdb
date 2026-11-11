import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createHandler, DEFAULT_SIGNED_PATH } from "../../supabase/functions/azerdex-ops-health/handler";
import { createGatedReportSource, GATE_SIG_HEADER, GATE_TS_HEADER, RPC_PATH } from "../../supabase/functions/azerdex-ops-health/report-source";
import { runEndpointChecks } from "../src/health/endpoint-check";
import { HttpHealthProvider } from "../src/health/http-provider";
import { checkFreshness, evaluateReporting, evaluateSnapshot } from "../src/monitor/evaluate";
import { testConfig } from "./helpers/fakes";

/**
 * AZR-004 Option G end to end, on a DISPOSABLE PostgreSQL with synthetic data: the bot's real HttpHealthProvider -> the real, UNCHANGED endpoint core
 * (supabase/functions/azerdex-ops-health/handler.ts) -> the real gated source (report-source.ts) -> a shim that does what PostgREST does for the request
 * (login as authenticator is not needed here: SET ROLE anon, request.headers / request.method) -> the real SQL gate public.ops_health_report() -> the real
 * ops_report.health() projection -> the bot's strict contract and evaluation. It also runs the owner's post-deployment check core against the same chain.
 *
 * Runs only when scripts/ops-health-gated-rpc-tests.sh sets OPS_HEALTH_GATE_E2E_DB and OPS_HEALTH_GATE_E2E_KEY (PGHOST/PGPORT/PGUSER from the environment).
 * Every scenario is one transaction that is rolled back: nothing persists. The key is read from the environment and never printed.
 */
const DB = process.env.OPS_HEALTH_GATE_E2E_DB;
const KEY = process.env.OPS_HEALTH_GATE_E2E_KEY ?? "";
const SECRET = "e".repeat(40);
const URL_ = "https://project.supabase.co" + DEFAULT_SIGNED_PATH;
const SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
const APIKEY = "sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAA";

// Same synthetic data as gate-c-e2e.test.ts (kept in step by hand: that file is not modified by this change).
const BASE = `
delete from cron.job_run_details; delete from cron.job;
insert into cron.job (jobid, jobname, schedule, command) values
  (1, 'azerdex-news-blueposts', '*/10 * * * *', 'x'), (2, 'azerdex-news-official', '*/30 * * * *', 'x'), (7, 'azerdex-news-health', '*/15 * * * *', 'select private.azerdex_news_assert_healthy()');
delete from pub.news_sources;
insert into pub.news_sources (source_key, source_type, region, endpoint_url, last_attempt_at, last_fetch_ok_at, last_official_post_at) values
  ('blizzard-bluepost-us', 'bluepost', 'us', 'https://example.com/us', now() - interval '4 minutes', now() - interval '4 minutes', now() - interval '9 days'),
  ('blizzard-bluepost-eu', 'bluepost', 'eu', 'https://example.com/eu', now() - interval '4 minutes', now() - interval '4 minutes', now() - interval '9 days'),
  ('blizzard-news-us', 'official_news', 'us', 'https://example.com/news', now() - interval '4 minutes', now() - interval '4 minutes', now() - interval '9 days');
insert into cron.job_run_details (jobid, status, start_time) values (1, 'succeeded', now() - interval '4 minutes'), (2, 'succeeded', now() - interval '10 minutes'), (7, 'succeeded', now() - interval '7 minutes');`;
const SCENARIOS = {
  healthy: "",
  critical: `insert into pub.news_sync_runs (source_key, status, finished_at, error, error_category) select 'blizzard-bluepost-us', 'failed', now(), 'source_http_503', 'http_503' from generate_series(1, 4);
    update pub.news_sources set last_error_category = 'http_503' where source_key = 'blizzard-bluepost-us';
    update cron.job_run_details set status = 'failed' where jobid = 7;`,
  stale: `update pub.news_sources set last_attempt_at = now() - interval '3 hours', last_fetch_ok_at = now() - interval '3 hours' where source_key = 'blizzard-bluepost-us';
    delete from cron.job_run_details where jobid = 1; insert into cron.job_run_details (jobid, status, start_time) values (1, 'succeeded', now() - interval '3 hours');`,
  g6_missing: `delete from cron.job_run_details where jobid = 7; delete from cron.job where jobid = 7;`,
  g6_inactive: `update cron.job set active = false where jobid = 7;`,
  unavailable: `create or replace function private.azerdex_news_health() returns jsonb language plpgsql as $$ begin raise exception 'simulated G2 outage'; end $$;`,
} as const;
type Scenario = keyof typeof SCENARIOS;

/** What PostgREST does for GET /rest/v1/rpc/ops_health_report, minus HTTP: one rolled-back transaction, SET ROLE anon, request.* settings, call the wrapper. */
function postgrestShim(scenario: Scenario, counter: { calls: number }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    counter.calls += 1;
    const url = new URL(String(input));
    if (url.pathname !== RPC_PATH || (init?.method ?? "GET") !== "GET") return new Response("{}", { status: 404 });
    const h = init?.headers as Record<string, string>;
    const headers = JSON.stringify({ [GATE_TS_HEADER]: h[GATE_TS_HEADER], [GATE_SIG_HEADER]: h[GATE_SIG_HEADER], "user-agent": "shim" });
    const sql = `begin;\n${BASE}\n${SCENARIOS[scenario]}\nset local role anon;\nselect set_config('request.headers', :'hdrs', true) \\g /dev/null\nselect set_config('request.method', 'GET', true) \\g /dev/null\nselect public.ops_health_report();\nrollback;\n`;
    try {
      const out = execFileSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-v", `hdrs=${headers}`, "-d", DB!], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      return new Response(out.trim(), { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      return stderr.includes("unauthorized") ? new Response(JSON.stringify({ code: "PT401", message: "unauthorized", details: null, hint: null }), { status: 401 })
                                             : new Response(JSON.stringify({ code: "P0001", message: "error" }), { status: 400 });
    }
  }) as unknown as typeof fetch;
}

const cfg = testConfig();
function chain(scenario: Scenario, over: { gateKey?: string; sourceNow?: () => number; secret?: string } = {}) {
  const counter = { calls: 0 };
  const handler = createHandler({
    secret: SECRET, signedPath: DEFAULT_SIGNED_PATH, now: () => Date.now(),
    readReport: createGatedReportSource({ supabaseUrl: SUPABASE_URL, apikey: APIKEY, gateKeyHex: over.gateKey ?? KEY, now: over.sourceNow ?? (() => Date.now()), fetchFn: postgrestShim(scenario, counter) }),
  });
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input as string, init))) as typeof fetch;
  return { counter, fetchFn, provider: new HttpHealthProvider({ url: URL_, secret: over.secret ?? SECRET, fetchFn }) };
}
async function findings(scenario: Scenario) {
  const r = await chain(scenario).provider.fetchSnapshot();
  if (!r.ok) throw new Error(`provider failed: ${r.failure}`);
  const now = Date.parse(r.snapshot.generatedAt);
  expect(checkFreshness(r.snapshot, now + 1000, cfg.tuning)).toBe("ok");
  return Object.fromEntries(evaluateSnapshot(r.snapshot, now, cfg).map((f) => [f.component, f]));
}

describe.skipIf(!DB || KEY.length !== 64)("Option G end to end: real SQL gate -> real gated source -> unchanged handler -> real provider -> real evaluation", () => {
  it("healthy data: the bot sees every source and the G6 job healthy", async () => {
    const f = await findings("healthy");
    expect(Object.values(f).map((x) => x.state)).toEqual(["HEALTHY", "HEALTHY", "HEALTHY", "HEALTHY"]);
    expect(f["g6:job"]!.reasonCode).toBe("g6_ok");
  });
  it("critical, stale and G6 states come through the gate exactly as they did through the direct reporter", async () => {
    expect((await findings("critical"))["source:blizzard-bluepost-us"]).toMatchObject({ state: "CRITICAL", reasonCode: "fetch_failing" });
    expect((await findings("stale"))["source:blizzard-bluepost-us"]).toMatchObject({ state: "CRITICAL", reasonCode: "collector_stopped" });
    expect((await findings("g6_missing"))["g6:job"]).toMatchObject({ state: "CRITICAL", reasonCode: "g6_job_missing" });
    expect((await findings("g6_inactive"))["g6:job"]).toMatchObject({ state: "CRITICAL", reasonCode: "g6_job_inactive" });
  });
  it("a failing G2 function is HTTP 503 -> provider `server` -> UNKNOWN below the threshold, CRITICAL at it, never healthy", async () => {
    const r = await chain("unavailable").provider.fetchSnapshot();
    expect(r).toMatchObject({ ok: false, failure: "server", httpStatus: 503 });
    expect(evaluateReporting("server", 1, cfg.tuning, 503).state).toBe("UNKNOWN");
    expect(evaluateReporting("server", cfg.tuning.providerFailureThreshold, cfg.tuning, 503).state).toBe("CRITICAL");
  });
  it("a wrong gate key, or a clock two minutes off, is refused by the database and reaches the bot as 503 (UNKNOWN), never as health", async () => {
    expect(await chain("healthy", { gateKey: "ab".repeat(32) }).provider.fetchSnapshot()).toMatchObject({ ok: false, failure: "server", httpStatus: 503 });
    expect(await chain("healthy", { sourceNow: () => Date.now() - 120_000 }).provider.fetchSnapshot()).toMatchObject({ ok: false, failure: "server", httpStatus: 503 });
    expect(await chain("healthy", { sourceNow: () => Date.now() + 120_000 }).provider.fetchSnapshot()).toMatchObject({ ok: false, failure: "server", httpStatus: 503 });
  });
  it("a wrong external secret is a uniform 401 `auth` and the database is never touched", async () => {
    const c = chain("healthy", { secret: "w".repeat(40) });
    expect(await c.provider.fetchSnapshot()).toMatchObject({ ok: false, failure: "auth", httpStatus: 401 });
    expect(c.counter.calls).toBe(0);
  });
  it("the owner's post-deployment check (check-health-endpoint.ts core) passes unchanged against the new chain: 4 refusals, 1 signed read, contract, freshness", async () => {
    const c = chain("healthy");
    const results = await runEndpointChecks({ url: URL_, secret: SECRET, fetchFn: c.fetchFn });
    expect(results.filter((r) => !r.pass), JSON.stringify(results)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(9);
    expect(c.counter.calls).toBe(1);      // only the signed read reaches the database; the four refusals are answered by the handler
  });
  it("no log output anywhere in the chain", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await chain("healthy").provider.fetchSnapshot(); await chain("healthy", { gateKey: "ab".repeat(32) }).provider.fetchSnapshot();
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });
});
