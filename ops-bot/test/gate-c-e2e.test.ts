import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createHandler, DEFAULT_SIGNED_PATH } from "../../supabase/functions/azerdex-ops-health/handler";
import { HttpHealthProvider } from "../src/health/http-provider";
import { checkFreshness, evaluateReporting, evaluateSnapshot } from "../src/monitor/evaluate";
import { harness } from "./helpers/harness";
import { testConfig } from "./helpers/fakes";

/**
 * Gate C end to end, on a DISPOSABLE PostgreSQL with synthetic data: the bot's real HttpHealthProvider -> the real endpoint core
 * (supabase/functions/azerdex-ops-health/handler.ts) -> the real SQL function ops_report.health() executed AS the restricted role
 * azerdex_ops_reporter -> the bot's strict contract and its real evaluation / incident engine.
 *
 * Runs only when OPS_HEALTH_E2E_DB names the database left in the applied state by scripts/ops-health-sql-tests.sh (PGHOST/PGPORT/PGUSER from the environment).
 * Every scenario is one transaction that is rolled back: nothing persists.
 */
const DB = process.env.OPS_HEALTH_E2E_DB;
const SECRET = "e".repeat(40);
const URL_ = "https://project.supabase.co" + DEFAULT_SIGNED_PATH;

const BASE = `
delete from cron.job_run_details; delete from cron.job;
insert into cron.job (jobid, jobname, schedule, command) values
  (1, 'azerdex-news-blueposts', '*/10 * * * *', 'x'), (2, 'azerdex-news-official', '*/30 * * * *', 'x'), (7, 'azerdex-news-health', '*/15 * * * *', 'select private.azerdex_news_assert_healthy()');
insert into pub.news_sources (source_key, source_type, region, endpoint_url, last_attempt_at, last_fetch_ok_at, last_official_post_at) values
  ('blizzard-bluepost-us', 'bluepost', 'us', 'https://example.com/us', now() - interval '4 minutes', now() - interval '4 minutes', now() - interval '9 days'),
  ('blizzard-bluepost-eu', 'bluepost', 'eu', 'https://example.com/eu', now() - interval '4 minutes', now() - interval '4 minutes', now() - interval '9 days'),
  ('blizzard-news-us', 'official_news', 'us', 'https://example.com/news', now() - interval '4 minutes', now() - interval '4 minutes', now() - interval '9 days');
insert into cron.job_run_details (jobid, status, start_time) values (1, 'succeeded', now() - interval '4 minutes'), (2, 'succeeded', now() - interval '10 minutes'), (7, 'succeeded', now() - interval '6 minutes');`;

const SCENARIOS = {
  healthy: "",
  warning: `insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title, region, published_at, category, relevance, status, content_hash)
    values ('blizzard-bluepost-us', 'post:hidden', 'topic:1', 5, 'us:topic:1', 'hidden-reply', 'https://example.com/t/1/5', 'hidden', 'us', now() - interval '1 day', 'bluepost', 'relevant', 'published', repeat('a', 64));`,
  critical: `insert into pub.news_sync_runs (source_key, status, finished_at, error, error_category) select 'blizzard-bluepost-us', 'failed', now(), 'source_http_503', 'http_503' from generate_series(1, 3);
    update pub.news_sources set last_error_category = 'http_503' where source_key = 'blizzard-bluepost-us';
    update cron.job_run_details set status = 'failed' where jobid = 7;`,
  stale: `update pub.news_sources set last_attempt_at = now() - interval '3 hours', last_fetch_ok_at = now() - interval '3 hours' where source_key = 'blizzard-bluepost-us';
    delete from cron.job_run_details where jobid = 1; insert into cron.job_run_details (jobid, status, start_time) values (1, 'succeeded', now() - interval '3 hours');`,
  g6_missing: `delete from cron.job_run_details where jobid = 7; delete from cron.job where jobid = 7;`,
  g6_inactive: `update cron.job set active = false where jobid = 7;`,
  g6_stalled: `delete from cron.job_run_details where jobid = 7; insert into cron.job_run_details (jobid, status, start_time) values (7, 'succeeded', now() - interval '90 minutes');`,
  unavailable: `create or replace function private.azerdex_news_health() returns jsonb language plpgsql as $$ begin raise exception 'simulated G2 outage'; end $$;`,
} as const;
type Scenario = keyof typeof SCENARIOS;

/** Runs one scenario in a rolled-back transaction and returns what the REAL function returns when called AS the reporting role. Throws if it raises. */
function readAsReporter(scenario: Scenario): unknown {
  const sql = `begin;\n${BASE}\n${SCENARIOS[scenario]}\nset local role azerdex_ops_reporter;\nselect ops_report.health();\nrollback;\n`;
  const out = execFileSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-d", DB!], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(out.trim());
}

function endpoint(scenario: Scenario, secret = SECRET) {
  const handle = createHandler({ secret: SECRET, signedPath: DEFAULT_SIGNED_PATH, now: () => Date.now(), readReport: async () => readAsReporter(scenario) });
  return new HttpHealthProvider({ url: URL_, secret, fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input as string, init))) as typeof fetch });
}
const cfg = testConfig();
async function findings(scenario: Scenario) {
  const r = await endpoint(scenario).fetchSnapshot();
  if (!r.ok) throw new Error(`provider failed: ${r.failure}`);
  const now = Date.parse(r.snapshot.generatedAt);
  expect(checkFreshness(r.snapshot, now + 1000, cfg.tuning)).toBe("ok");
  return Object.fromEntries(evaluateSnapshot(r.snapshot, now, cfg).map((f) => [f.component, f]));
}

describe.skipIf(!DB)("Gate C end to end: real PostgreSQL function -> real endpoint core -> real provider -> real evaluation", () => {
  it("healthy data: the bot sees every source and the G6 job healthy (zero new posts is not a fault)", async () => {
    const f = await findings("healthy");
    expect(Object.values(f).map((x) => x.state)).toEqual(["HEALTHY", "HEALTHY", "HEALTHY", "HEALTHY"]);
    expect(f["source:blizzard-bluepost-us"]!.reasonCode).toBe("healthy_no_new_content");
    expect(f["g6:job"]!.reasonCode).toBe("g6_ok");
  });

  it("warning data: a display gap is a WARNING for that source only", async () => {
    const f = await findings("warning");
    expect(f["source:blizzard-bluepost-us"]).toMatchObject({ state: "WARNING", reasonCode: "display_gap" });
    expect(f["source:blizzard-bluepost-eu"]!.state).toBe("HEALTHY");
  });

  it("critical data: repeated fetch failures are CRITICAL, and the failed G6 run is explained by that source (no second incident)", async () => {
    const f = await findings("critical");
    expect(f["source:blizzard-bluepost-us"]).toMatchObject({ state: "CRITICAL", reasonCode: "fetch_failing" });
    expect(f["g6:job"]).toMatchObject({ state: "WARNING", reasonCode: "g6_run_failed_explained_by_source" });
  });

  it("stale data: a collector that stopped is CRITICAL (collector_stopped)", async () => {
    expect((await findings("stale"))["source:blizzard-bluepost-us"]).toMatchObject({ state: "CRITICAL", reasonCode: "collector_stopped" });
  });

  it("G6 job states: missing, inactive and stalled are each CRITICAL with their own reason", async () => {
    expect((await findings("g6_missing"))["g6:job"]).toMatchObject({ state: "CRITICAL", reasonCode: "g6_job_missing" });
    expect((await findings("g6_inactive"))["g6:job"]).toMatchObject({ state: "CRITICAL", reasonCode: "g6_job_inactive" });
    expect((await findings("g6_stalled"))["g6:job"]).toMatchObject({ state: "CRITICAL", reasonCode: "g6_schedule_stalled" });
  });

  it("unavailable data: a failing G2 function is HTTP 503 -> provider `server` -> UNKNOWN below the threshold, CRITICAL at it, never healthy", async () => {
    const r = await endpoint("unavailable").fetchSnapshot();
    expect(r).toMatchObject({ ok: false, failure: "server", httpStatus: 503 });
    expect(evaluateReporting("server", 1, cfg.tuning, 503).state).toBe("UNKNOWN");
    expect(evaluateReporting("server", cfg.tuning.providerFailureThreshold, cfg.tuning, 503).state).toBe("CRITICAL");
  });

  it("a wrong shared secret is refused before the database is touched: provider `auth`", async () => {
    expect(await endpoint("healthy", "w".repeat(40)).fetchSnapshot()).toMatchObject({ ok: false, failure: "auth", httpStatus: 401 });
  });

  it("the endpoint's data really comes from the restricted role: the same query as that role cannot read the underlying tables", () => {
    const sql = `set role azerdex_ops_reporter; select count(*) from pub.news_sources;`;
    expect(() => execFileSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-d", DB!], { input: sql, stdio: ["pipe", "pipe", "pipe"] })).toThrow(/permission denied/);
  });

  it("full monitoring cycles with the real provider: healthy opens nothing; a critical source opens exactly one incident; an outage is UNKNOWN twice and only then a reporting incident, sources never resolved", async () => {
    const h = await harness();
    h.clock.t = Date.now();
    let scenario: Scenario = "healthy";
    h.deps.provider = { fetchSnapshot: () => endpoint(scenario).fetchSnapshot() };   // a fresh endpoint per poll: no 10 s report cache between scenarios
    const incidents = () => h.db.rows<{ component: string; status: string }>("select component, status from incidents order by component");
    await h.cycle();
    expect(incidents()).toEqual([]);

    scenario = "critical"; h.clock.minutes(5); h.clock.t = Math.max(h.clock.t, Date.now());
    await h.cycle();
    expect(incidents()).toEqual([{ component: "source:blizzard-bluepost-us", status: "OPEN" }]);
    expect(h.discord.creates).toHaveLength(1);

    scenario = "unavailable";
    for (let i = 1; i <= cfg.tuning.providerFailureThreshold; i++) { h.clock.minutes(5); h.clock.t = Math.max(h.clock.t, Date.now()); await h.cycle(); if (i < cfg.tuning.providerFailureThreshold) expect(incidents().map((x) => x.component)).toEqual(["source:blizzard-bluepost-us"]); }
    expect(incidents().map((x) => x.component).sort()).toEqual(["source:blizzard-bluepost-us", "supabase:reporting"]);
    expect(incidents().find((x) => x.component === "source:blizzard-bluepost-us")!.status).not.toBe("RESOLVED");   // an outage never resolves a real incident
  });
});
