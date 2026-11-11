import { execFile, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { GATE_SIG_HEADER, GATE_TS_HEADER } from "../../supabase/functions/azerdex-ops-health/report-source";

/**
 * AZR-004 Option G: abusive anonymous traffic, connection exhaustion and database workload, measured through a REAL PostgREST over HTTP (not a SQL microbenchmark).
 * The gate is callable by `anon`, so the questions are: (1) does a flood of refused requests starve the legitimate caller, (2) does it exhaust database connections,
 * (3) what does one refusal cost the database, (4) what is the worst case if the key leaked, and (5) how fast does the kill switch bite under load.
 * Skipped unless scripts/ops-health-gated-rpc-tests.sh sets the environment. Prints one JSON line per phase (no secrets). Bounds asserted here are deliberately loose
 * (CI machines are noisy); the numbers are the evidence. Hosted Supabase adds its own edge protection and pool limits on top; see docs/ops-bot/reporting-gated-rpc.md.
 */
const BASE = process.env.OPS_HEALTH_POSTGREST_URL;
const DB = process.env.OPS_HEALTH_DB;
const NEEDLES = process.env.OPS_HEALTH_NEEDLES_FILE;
const KEYS_FILE = process.env.OPS_HEALTH_KEYS_FILE;
const METRICS_FILE = process.env.OPS_HEALTH_METRICS_FILE;     // one JSON line per phase; printed by the script (vitest hides console output of passing tests)
const emit = (line: object) => { const text = JSON.stringify(line); console.info(`INFO: ${text}`); if (METRICS_FILE) appendFileSync(METRICS_FILE, text + "\n"); };
const PGRST_PID = process.env.OPS_HEALTH_POSTGREST_PID;
const SECONDS = Math.max(3, Number(process.env.OPS_HEALTH_LOAD_SECONDS ?? 12));
const enabled = Boolean(BASE && DB && PGRST_PID);
const run = promisify(execFile);

const keys: string[] = [];
const sigs = new Set<string>();
afterAll(() => {
  if (NEEDLES) appendFileSync(NEEDLES, [...sigs].join("\n") + "\n");
  if (KEYS_FILE) appendFileSync(KEYS_FILE, keys.join("\n") + "\n");
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
const target = BASE ? new URL(BASE) : null;
const nowSec = () => Math.floor(Date.now() / 1000);
function sign(key: string, ts: number): string { const s = createHmac("sha256", Buffer.from(key, "hex")).update(`${ts}\nGET\nops_health_report`).digest("hex"); if (sigs.size < 3000) sigs.add(s); return s; }
function hit(headers: Record<string, string>): Promise<{ status: number; ms: number; start: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const req = http.request({ host: target!.hostname, port: target!.port, path: "/rpc/ops_health_report", method: "GET", headers, agent }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: performance.now() - t0, start: t0 })); });
    req.on("error", () => resolve({ status: 0, ms: performance.now() - t0, start: t0 }));
    req.setTimeout(15_000, () => req.destroy());
    req.end();
  });
}
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10; };
const tally = (xs: { status: number }[]) => xs.reduce<Record<string, number>>((m, x) => { m[x.status] = (m[x.status] ?? 0) + 1; return m; }, {});
const psql = (sql: string) => execFileSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-d", DB!], { input: sql, encoding: "utf8" }).trim();
function cpuSeconds(match: (comm: string, pid: string) => boolean): number | null {
  try {
    let ticks = 0;
    for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
        const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (match(comm, pid)) ticks += Number(f[11]) + Number(f[12]);
      } catch { /* the process exited */ }
    }
    return ticks / 100;
  } catch { return null; }
}
const dbCpu = () => cpuSeconds((comm) => comm === "postgres");
const apiCpu = () => cpuSeconds((_c, pid) => pid === PGRST_PID);
async function connectionSampler() {
  let max = 0, stop = false;
  const loop = (async () => {
    while (!stop) {
      try { const { stdout } = await run("psql", ["-X", "-q", "-tA", "-d", DB!, "-c", "select count(*) from pg_stat_activity where usename = 'authenticator'"]); max = Math.max(max, Number(stdout.trim())); } catch { /* sampling is best effort */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  })();
  return { stop: async () => { stop = true; await loop; return max; } };
}
/** Runs `concurrency` workers for `seconds`, each looping on make(); returns every result. */
async function flood(concurrency: number, seconds: number, make: (i: number) => Record<string, string>) {
  const results: { status: number; ms: number; start: number }[] = []; const end = Date.now() + seconds * 1000; let n = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (Date.now() < end) results.push(await hit(make(n++))); }));
  return results;
}
const summary = (label: string, rs: { status: number; ms: number }[], seconds: number, extra: object = {}) => {
  const line = { phase: label, requests: rs.length, perSecond: Math.round(rs.length / seconds), status: tally(rs), latencyMs: { p50: pct(rs.map((r) => r.ms), 50), p95: pct(rs.map((r) => r.ms), 95), p99: pct(rs.map((r) => r.ms), 99) }, ...extra };
  emit(line); return line;
};

describe.skipIf(!enabled)("Option G under abusive anonymous traffic (real PostgREST, pool of 10)", () => {
  let KEY = "";
  it("baseline: 30 sequential legitimate requests", async () => {
    KEY = psql("select ops_report.rotate_gate_key()"); keys.push(KEY);
    const rs: { status: number; ms: number }[] = [];
    for (let i = 0; i < 30; i++) { const ts = nowSec(); rs.push(await hit({ [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: sign(KEY, ts) })); }
    summary("baseline_valid", rs, rs.reduce((a, r) => a + r.ms, 0) / 1000);
    expect(tally(rs)).toEqual({ 200: 30 });
  });

  it("a flood of refused requests (no headers / wrong signature / stale / malformed) at high concurrency does not starve the legitimate caller or exhaust connections", async () => {
    const sampler = await connectionSampler();
    const cpu0 = { db: dbCpu(), api: apiCpu() }; const t0 = Date.now();
    const kinds = [
      () => ({}),
      () => ({ [GATE_TS_HEADER]: String(nowSec()), [GATE_SIG_HEADER]: "0".repeat(64) }),
      () => { const ts = nowSec() - 3600; return { [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: sign(KEY, ts) }; },
      () => ({ [GATE_TS_HEADER]: "nope", [GATE_SIG_HEADER]: "ZZ" }),
    ];
    const legit: { status: number; ms: number }[] = []; let probing = true;
    const prober = (async () => { while (probing) { const ts = nowSec(); legit.push(await hit({ [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: sign(KEY, ts) })); await new Promise((r) => setTimeout(r, 200)); } })();
    const attack = await flood(128, SECONDS, (i) => kinds[i % kinds.length]!());
    probing = false; await prober;
    const elapsed = (Date.now() - t0) / 1000; const maxConn = await sampler.stop();
    const cpu1 = { db: dbCpu(), api: apiCpu() };
    const cpuPer1000 = cpu0.db !== null && cpu1.db !== null ? { postgresCpuSecPer1000Requests: Math.round(((cpu1.db - cpu0.db) / (attack.length + legit.length)) * 1e5) / 100, postgrestCpuSecPer1000Requests: Math.round((((cpu1.api ?? 0) - (cpu0.api ?? 0)) / (attack.length + legit.length)) * 1e5) / 100 } : { note: "process CPU not visible here" };
    summary("refused_flood", attack, elapsed, { concurrency: 128, maxAuthenticatorConnections: maxConn, ...cpuPer1000 });
    summary("legitimate_during_flood", legit, elapsed);
    const non401 = attack.filter((r) => r.status !== 401).length;
    expect(attack.length).toBeGreaterThan(500);
    expect(non401 / attack.length, `non-401 statuses: ${JSON.stringify(tally(attack))}`).toBeLessThan(0.01);
    expect(legit.length).toBeGreaterThan(5);
    expect(legit.filter((r) => r.status === 200).length / legit.length, JSON.stringify(tally(legit))).toBeGreaterThanOrEqual(0.99);
    expect(pct(legit.map((r) => r.ms), 95)).toBeLessThan(3000);
    expect(maxConn, "PostgREST pool is 10; the database must never see more than the pool (plus a listener)").toBeLessThanOrEqual(12);
  }, (SECONDS + 60) * 1000);

  it("worst case if the key leaked: valid signed requests at saturation are served (read-only report) at a measured rate, and the kill switch bites immediately under that load", async () => {
    const sampler = await connectionSampler(); const seconds = Math.min(SECONDS, 8);
    const cpu0 = { db: dbCpu(), api: apiCpu() }; const t0 = Date.now();
    const valid = await flood(64, seconds, () => { const ts = nowSec(); return { [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: sign(KEY, ts) }; });
    const elapsed = (Date.now() - t0) / 1000; const maxConn = await sampler.stop(); const cpu1 = { db: dbCpu(), api: apiCpu() };
    summary("leaked_key_saturation", valid, elapsed, { concurrency: 64, maxAuthenticatorConnections: maxConn, ...(cpu0.db !== null && cpu1.db !== null ? { postgresCpuSecPer1000Requests: Math.round(((cpu1.db - cpu0.db) / valid.length) * 1e5) / 100 } : {}) });
    expect(valid.filter((r) => r.status === 200).length / valid.length, JSON.stringify(tally(valid))).toBeGreaterThanOrEqual(0.99);
    expect(maxConn).toBeLessThanOrEqual(12);
    // kill switch while requests are in flight: EVERY request that STARTS after the revoke has returned must be refused (a request already executing may still finish)
    const inflight = flood(32, 3, () => { const ts = nowSec(); return { [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: sign(KEY, ts) }; });
    await new Promise((r) => setTimeout(r, 800));
    psql("select ops_report.revoke_gate()"); const revokedAt = performance.now();
    const all = await inflight;
    const startedAfter = all.filter((r) => r.start > revokedAt), startedBefore = all.filter((r) => r.start <= revokedAt);
    const lateOk = startedAfter.filter((r) => r.status !== 401);
    emit({ phase: "kill_switch_under_load", requestsStartedBeforeRevoke: startedBefore.length, requestsStartedAfterRevoke: startedAfter.length, startedAfterRevokeNot401: lateOk.length, tallyAfter: tally(startedAfter) });
    expect(startedAfter.length).toBeGreaterThan(10);
    expect(lateOk, "a request that started after revoke_gate() returned was not refused").toEqual([]);
    // the report is readable again only after a new key is created
    KEY = psql("select ops_report.rotate_gate_key()"); keys.push(KEY);
    const ts = nowSec(); expect((await hit({ [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: sign(KEY, ts) })).status).toBe(200);
  }, (SECONDS + 60) * 1000);
});
