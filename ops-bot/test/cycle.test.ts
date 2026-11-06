import { describe, expect, it, vi } from "vitest";
import { harness, type Harness } from "./helpers/harness";
import { healthySnapshot, ok, withSource } from "../src/health/mock-provider";
import type { ProviderResult } from "../src/health/provider";
import { runCycle } from "../src/monitor/cycle";

const failingSource = (h: Harness) => h.provider.setFallback(() => ok({
  ...withSource(healthySnapshot(h.clock.now()), "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"], consecutiveFailures: 3 }),
}));
const healthyAgain = (h: Harness) => h.provider.setFallback(() => ok(healthySnapshot(h.clock.now())));
const fail = (failure: ProviderResult & { ok: false }) => failure;
const step = async (h: Harness, minutes = 5) => { h.clock.minutes(minutes); return h.cycle(); };
const incidents = (h: Harness) => h.db.rows<{ id: string; component: string; status: string; healthy_streak: number }>("select id, component, status, healthy_streak from incidents order by first_seen_at");

describe("healthy polling", () => {
  it("many healthy polls (including healthy_no_new_content) raise no alert, create no incident and send no Discord message", async () => {
    const h = await harness();
    for (let i = 0; i < 12; i++) await step(h);
    expect(h.discord.calls).toHaveLength(0);
    expect(incidents(h)).toHaveLength(0);
    expect(h.heartbeat.calls.every((c) => c.kind === "success" && c.signal === "ok")).toBe(true);
    expect(h.heartbeat.calls).toHaveLength(12);
    expect(h.db.rows<{ state: string }>("select state from component_state").every((r) => r.state === "HEALTHY")).toBe(true);
  });
});

describe("source failure, repetition and recovery", () => {
  it("critical G2 source -> exactly one actionable alert; the G6 failure it causes is explained, not a second incident", async () => {
    const h = await harness();
    await h.cycle();
    h.provider.setFallback(() => ok(withSource(healthySnapshot(h.clock.now(), { g6: { ...healthySnapshot(h.clock.now()).g6, lastRunStatus: "failed" } }), "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"] })));
    await step(h);
    expect(incidents(h)).toHaveLength(1);
    expect(incidents(h)[0]!.component).toBe("source:blizzard-bluepost-us");
    expect(h.discord.creates).toHaveLength(1);
    expect(h.db.rows<{ state: string }>("select state from component_state where component = 'g6:job'")[0]!.state).toBe("WARNING");
  });

  it("repeated identical critical events: one alert, then one bounded reminder, never a storm", async () => {
    const h = await harness();
    failingSource(h);
    for (let i = 0; i < 12; i++) await step(h);          // 60 minutes
    expect(h.discord.creates).toHaveLength(1);
    for (let i = 0; i < 24; i++) await step(h);          // up to 3 hours
    expect(h.discord.creates).toHaveLength(2);           // original + one reminder
    for (let i = 0; i < 60; i++) await step(h);          // 8 hours
    expect(h.discord.creates).toHaveLength(2);
  });

  it("recovery after a critical failure: one RECOVERED message referencing the same incident, after two confirmations", async () => {
    const h = await harness();
    failingSource(h); await h.cycle();
    const id = incidents(h)[0]!.id;
    healthyAgain(h);
    await step(h);
    expect(incidents(h)[0]!.status).toBe("OPEN");        // one healthy poll is not enough
    expect(h.discord.creates).toHaveLength(1);
    await step(h);
    expect(incidents(h)[0]!.status).toBe("RESOLVED");
    expect(h.discord.creates).toHaveLength(2);
    const rec = h.discord.creates[1]!.body as { embeds: Array<{ title: string; footer: { text: string } }>; components: unknown[] };
    expect(rec.embeds[0]!.title).toContain("RECOVERED");
    expect(rec.embeds[0]!.footer.text).toContain(id);
    expect(rec.components).toEqual([]);                  // nothing left to acknowledge
    for (let i = 0; i < 6; i++) await step(h);
    expect(h.discord.creates).toHaveLength(2);           // no repeated recoveries
  });

  it("a flapping source does not spam: relapse inside the confirmation window keeps the SAME incident and message", async () => {
    const h = await harness();
    failingSource(h); await h.cycle();
    healthyAgain(h); await step(h);
    failingSource(h); await step(h);
    expect(incidents(h)).toHaveLength(1);
    expect(h.discord.creates).toHaveLength(1);
  });
});

describe("parallel invocations", () => {
  it("two overlapping scheduled invocations: one runs, the other is skipped; one incident, one message", async () => {
    const h = await harness();
    failingSource(h);
    const results = await Promise.all([h.cycle(), h.cycle(), h.cycle()]);
    expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "skipped_locked")).toHaveLength(2);
    expect(incidents(h)).toHaveLength(1);
    expect(h.discord.creates).toHaveLength(1);
  });
  it("an expired lease from a crashed run does not block the next cycle", async () => {
    const h = await harness();
    h.db.raw.prepare("insert into locks values ('cycle', 'dead-holder', ?)").run(h.clock.now() + 1000);
    expect((await h.cycle()).status).toBe("skipped_locked");
    h.clock.minutes(10);
    expect((await h.cycle()).status).toBe("completed");
  });
});

describe("G6 schedule scenarios", () => {
  const g6 = (h: Harness, over: object) => h.provider.setFallback(() => ok(healthySnapshot(h.clock.now(), { g6: { ...healthySnapshot(h.clock.now()).g6, ...over } })));
  it("stopped G6 schedule (no executions arriving) opens a g6:job incident", async () => {
    const h = await harness();
    g6(h, { lastRunAt: new Date(h.clock.now() - 90 * 60_000).toISOString() });
    await h.cycle();
    expect(incidents(h).map((i) => i.component)).toEqual(["g6:job"]);
    expect(h.discord.creates).toHaveLength(1);
  });
  it("G6 job disappearing, or becoming inactive, opens an incident (and recovers when restored)", async () => {
    const h = await harness();
    g6(h, { present: false, active: false }); await h.cycle();
    expect(h.db.rows<{ reason_code: string }>("select reason_code from incidents")[0]!.reason_code).toBe("g6_job_missing");
    g6(h, { present: true, active: false }); await step(h);
    expect(h.db.rows<{ reason_code: string }>("select reason_code from incidents")[0]!.reason_code).toBe("g6_job_inactive");
    expect(h.db.count("incidents")).toBe(1);                    // same incident, updated cause
    expect(h.discord.creates).toHaveLength(2);                  // open + one meaningful update
    g6(h, {}); await step(h); await step(h);
    expect(incidents(h)[0]!.status).toBe("RESOLVED");
  });
  it("G6 failing with all sources healthy is unexplained and alerts", async () => {
    const h = await harness();
    g6(h, { lastRunStatus: "failed" }); await h.cycle();
    expect(h.db.rows<{ reason_code: string }>("select reason_code from incidents")[0]!.reason_code).toBe("g6_run_failed_unexplained");
  });
});

describe("Supabase reporting failures (fail closed, bot stays operational)", () => {
  const cases: Array<[string, ProviderResult & { ok: false }, number, number]> = [
    ["HTTP 401", { ok: false, failure: "auth", httpStatus: 401 }, 2, 1],
    ["HTTP 403", { ok: false, failure: "auth", httpStatus: 403 }, 2, 1],
    ["HTTP 429", { ok: false, failure: "rate_limited", httpStatus: 429, retryAfterMs: 1000 }, 3, 3],
    ["HTTP 500", { ok: false, failure: "server", httpStatus: 500 }, 3, 3],
    ["timeout", { ok: false, failure: "timeout" }, 3, 3],
    ["network error", { ok: false, failure: "network" }, 3, 3],
    ["contract violation", { ok: false, failure: "contract", httpStatus: 200 }, 3, 1],
  ];
  it.each(cases)("%s: UNKNOWN first, CRITICAL 'reporting unavailable' after the threshold, bounded retries, never reported healthy", async (_n, failure, threshold, attemptsPerCycle) => {
    const h = await harness();
    await h.cycle(); // one healthy cycle establishes known components
    h.provider.setFallback(() => fail(failure));
    const before = h.provider.calls;
    for (let i = 1; i < threshold; i++) {
      await step(h);
      expect(incidents(h)).toHaveLength(0);                                   // below threshold: no page
      expect(h.db.rows<{ state: string }>("select state from component_state where component = 'supabase:reporting'")[0]!.state).toBe("UNKNOWN");
      expect(h.db.rows<{ state: string }>("select state from component_state where component = 'source:blizzard-bluepost-us'")[0]!.state).toBe("UNKNOWN");
    }
    await step(h);
    expect(incidents(h).map((x) => x.component)).toEqual(["supabase:reporting"]);
    expect(h.discord.creates).toHaveLength(1);                                // the bot recorded the incident and delivered it with Supabase down
    expect(h.provider.calls - before).toBe(threshold * attemptsPerCycle);     // retry attempts are bounded per cycle
    expect(h.heartbeat.calls.at(-1)).toEqual({ kind: "success", signal: "supabase_degraded" }); // bot alive, Supabase degraded
    expect(h.heartbeat.calls.some((c) => c.kind === "log" && c.signal === "supabase_degraded")).toBe(true);
    expect(h.heartbeat.calls.some((c) => c.kind === "fail")).toBe(false);     // a Supabase failure is NOT a bot failure
  });

  it("missing/expired monitoring responses: a stale snapshot is treated as a reporting failure, never as health", async () => {
    const h = await harness();
    await h.cycle();
    h.provider.setFallback(() => ok(healthySnapshot(h.clock.now(), { generatedAt: new Date(h.clock.now() - 45 * 60_000).toISOString() })));
    for (let i = 0; i < 3; i++) await step(h);
    expect(h.db.rows<{ reason_code: string }>("select reason_code from incidents")[0]!.reason_code).toBe("reporting_unavailable_stale");
  });

  it("an existing source incident is NOT resolved while reporting is down (UNKNOWN never counts as healthy)", async () => {
    const h = await harness();
    failingSource(h); await h.cycle();
    h.provider.setFallback(() => fail({ ok: false, failure: "server", httpStatus: 500 }));
    for (let i = 0; i < 10; i++) await step(h);
    const src = incidents(h).find((x) => x.component === "source:blizzard-bluepost-us")!;
    expect(src.status).toBe("OPEN");
    expect(src.healthy_streak).toBe(0);
  });

  it("reporting recovers: the monitor-degraded incident resolves and announces recovery once", async () => {
    const h = await harness();
    await h.cycle();
    h.provider.setFallback(() => fail({ ok: false, failure: "server", httpStatus: 500 }));
    for (let i = 0; i < 3; i++) await step(h);
    healthyAgain(h);
    await step(h); await step(h);
    expect(incidents(h).find((x) => x.component === "supabase:reporting")!.status).toBe("RESOLVED");
    expect(h.discord.creates).toHaveLength(2);
  });

  it("a transient 500 then success inside one cycle is retried and invisible to operators", async () => {
    const h = await harness();
    h.provider.enqueue({ ok: false, failure: "server", httpStatus: 500 });
    const r = await h.cycle();
    expect(r).toMatchObject({ status: "completed", reporting: "ok" });
    expect(h.provider.calls).toBe(2);
    expect(h.discord.calls).toHaveLength(0);
  });
});

describe("Discord failures during a cycle", () => {
  it("429: alert retried after Retry-After; not lost; no duplicate; heartbeat stays ok", async () => {
    const h = await harness();
    failingSource(h);
    h.discord.enqueue({ ok: false, class: "rate_limited", status: 429, retryAfterMs: 120_000 });
    await h.cycle();
    expect(h.db.count("outbox", "status = 'PENDING'")).toBe(1);
    await step(h);
    expect(h.db.count("outbox", "status = 'SENT'")).toBe(1);
    expect(h.discord.creates).toHaveLength(2);
    expect(h.heartbeat.calls.every((c) => c.kind === "success")).toBe(true);
  });

  it("persistent 5xx: DEAD after the bounded budget, announced once on the fallback route, and the heartbeat reports delivery_failing", async () => {
    const h = await harness();
    failingSource(h);
    for (let i = 0; i < 20; i++) h.discord.enqueue({ ok: false, class: "server", status: 500 });
    for (let i = 0; i < h.cfg.tuning.outboxMaxAttempts + 3; i++) await step(h, 16);
    expect(h.db.count("outbox", "status = 'DEAD'")).toBe(1);
    expect(h.fallback.sent).toHaveLength(1);
    expect(h.fallback.sent[0]).toMatch(/^AzerDex ops bot: Discord delivery failed for incident INC-/);
    expect(h.heartbeat.calls.some((c) => c.kind === "fail" && c.signal === "delivery_failing")).toBe(true);
    // bounded: the OPEN alert used exactly its retry budget; the single bounded reminder is the only other traffic (no message storm)
    expect(h.db.rows<{ attempts: number }>("select attempts from outbox where kind = 'OPEN'")[0]!.attempts).toBe(h.cfg.tuning.outboxMaxAttempts);
    expect(h.db.count("outbox", "kind = 'REMINDER'")).toBe(1);
    expect(h.discord.creates.length).toBeLessThanOrEqual(2 * h.cfg.tuning.outboxMaxAttempts);
  });

  it("Discord timeouts are retried with backoff and delivered later", async () => {
    const h = await harness();
    failingSource(h);
    h.discord.enqueue({ ok: false, class: "timeout" });
    await h.cycle();
    expect(h.db.count("outbox", "status = 'PENDING'")).toBe(1);
    await step(h);
    expect(h.db.count("outbox", "status = 'SENT'")).toBe(1);
  });
});

describe("independent heartbeat and bot execution failures", () => {
  it("a cycle crash signals the independent monitor immediately with /fail and rethrows (distinct from a Supabase failure)", async () => {
    const h = await harness();
    h.provider.setFallback(() => { throw new Error("boom: unexpected"); });
    await expect(h.cycle()).rejects.toThrow();
    expect(h.heartbeat.calls).toEqual([{ kind: "fail", signal: "cycle_error" }]);
    // the lease is released, so the next scheduled invocation is not blocked
    healthyAgain(h);
    expect((await step(h)).status).toBe("completed");
  });

  it("D1 failure mid-cycle is a bot failure: /fail ping, no success ping", async () => {
    const h = await harness();
    const real = h.db.prepare.bind(h.db);
    let n = 0;
    (h.deps.db as { prepare: unknown }).prepare = (sql: string) => { if (++n > 6 && sql.includes("component_state")) throw new Error("D1 unavailable"); return real(sql); };
    await expect(runCycle(h.deps)).rejects.toThrow();
    expect(h.heartbeat.calls.some((c) => c.kind === "success")).toBe(false);
    expect(h.heartbeat.calls.some((c) => c.kind === "fail" && c.signal === "cycle_error")).toBe(true);
  });

  it("missed Cloudflare cron executions: the bot detects the gap on its next run, opens an incident, logs it to the heartbeat, and resolves it once cycles are back on schedule", async () => {
    const h = await harness();
    await h.cycle();
    h.clock.minutes(47);                                    // nine missed 5-minute cycles
    const r = await h.cycle();
    expect(r).toMatchObject({ status: "completed", heartbeat: "schedule_gap" });
    expect(h.db.rows<{ component: string }>("select component from incidents").map((x) => x.component)).toEqual(["bot:schedule"]);
    expect(h.discord.creates).toHaveLength(1);
    expect(h.heartbeat.calls.some((c) => c.kind === "log" && c.signal === "schedule_gap")).toBe(true);
    await step(h); await step(h);
    expect(incidents(h)[0]!.status).toBe("RESOLVED");
  });

  it("an ordinary 5-minute cadence (even with jitter) is never mistaken for a gap", async () => {
    const h = await harness();
    for (const m of [5, 6, 4, 7, 5, 9, 5]) await step(h, m);
    expect(h.db.count("incidents")).toBe(0);
  });

  it("the heartbeat provider failing does not break the monitoring cycle", async () => {
    const h = await harness();
    h.heartbeat.success = async () => false;
    failingSource(h);
    expect((await h.cycle()).status).toBe("completed");
    expect(h.discord.creates).toHaveLength(1);
  });
});

describe("cycle with a hostile or surprising environment", () => {
  it("the heartbeat/fallback are never given error text, ids or URLs (fixed vocabulary only)", async () => {
    const h = await harness();
    failingSource(h);
    for (let i = 0; i < 20; i++) h.discord.enqueue({ ok: false, class: "server", status: 500 });
    for (let i = 0; i < 10; i++) await step(h, 16);
    const vocab = new Set(["ok", "supabase_degraded", "delivery_failing", "cycle_error", "config_error", "schedule_gap"]);
    expect(h.heartbeat.calls.every((c) => vocab.has(c.signal))).toBe(true);
    for (const t of h.fallback.sent) expect(t).not.toMatch(/https?:|token|secret/i);
  });
  it("vi is available for timers where needed (sanity)", () => expect(vi).toBeDefined());
});
