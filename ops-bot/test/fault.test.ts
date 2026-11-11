import { describe, expect, it, vi } from "vitest";
import { DiscordRestClient } from "../src/discord/client";
import { FAULT_KEY, createFaultFetch, parseFault } from "../src/discord/fault";
import { applyFinding, ensureOpenNotifications } from "../src/incidents/engine";
import { processOutbox } from "../src/incidents/outbox";
import type { Finding } from "../src/monitor/evaluate";
import { newDb, type TestDb } from "./helpers/d1";
import { T0, captureLog, testConfig } from "./helpers/fakes";

const CH = "https://discord.com/api/v10/channels/1569332852787642459/messages";
const setFault = (db: TestDb, v: string) => db.raw.prepare("insert into monitor_state (key, value, updated_at) values (?, ?, 0) on conflict(key) do update set value = excluded.value").run(FAULT_KEY, v);
const faultValue = (db: TestDb) => (db.raw.prepare("select value from monitor_state where key = ?").get(FAULT_KEY) as { value: string } | undefined)?.value;
const real = () => vi.fn(async () => new Response(JSON.stringify({ id: "1569332852787642999" }), { status: 200 }));
const post = (f: typeof fetch, url = CH, method = "POST") => f(url, { method, body: "{}" });

describe("staging-only Discord fault injection", () => {
  it("is never built outside staging", () => {
    const db = newDb();
    for (const env of ["production", "", "local", "Staging"]) expect(createFaultFetch(env, db)).toBeUndefined();
    expect(createFaultFetch("staging", db)).toBeTypeOf("function");
  });

  it("parses only well-formed positive counts of known kinds", () => {
    expect(parseFault("rate_limited:2")).toEqual({ kind: "rate_limited", remaining: 2 });
    for (const bad of [null, "", "rate_limited", "rate_limited:0", "rate_limited:-1", "rate_limited:1000", "nope:1", "rate_limited:1x", "RATE_LIMITED:1"]) expect(parseFault(bad)).toBeNull();
  });

  it("without a fault row everything passes through to the real fetch", async () => {
    const db = newDb(); const r = real();
    const f = createFaultFetch("staging", db, r as unknown as typeof fetch)!;
    expect((await post(f)).status).toBe(200);
    expect(r).toHaveBeenCalledTimes(1);
  });

  it("rate_limited:2 answers the next two message calls with a 429 + Retry-After and then stops, consuming exactly the count", async () => {
    const db = newDb(); const r = real(); setFault(db, "rate_limited:2");
    const f = createFaultFetch("staging", db, r as unknown as typeof fetch)!;
    const a = await post(f); const b = await post(f); const c = await post(f);
    expect([a.status, b.status, c.status]).toEqual([429, 429, 200]);
    expect(a.headers.get("retry-after")).toBe("20");
    expect(r).toHaveBeenCalledTimes(1);          // the two injected calls never reached Discord
    expect(faultValue(db)).toBe("rate_limited:0");
  });

  it("forbidden and server_error produce 403 and 503", async () => {
    const db = newDb(); const f = createFaultFetch("staging", db, real() as unknown as typeof fetch)!;
    setFault(db, "forbidden:1"); expect((await post(f)).status).toBe(403);
    setFault(db, "server_error:1"); expect((await post(f, CH + "/1569332852787642998", "PATCH")).status).toBe(503);
  });

  it("never touches reads, interaction webhooks, other hosts or other paths (operators keep their replies)", async () => {
    const db = newDb(); const r = real(); setFault(db, "rate_limited:5");
    const f = createFaultFetch("staging", db, r as unknown as typeof fetch)!;
    expect((await f(CH, { method: "GET" })).status).toBe(200);
    expect((await post(f, "https://discord.com/api/v10/webhooks/1569333874159521792/" + "T".repeat(40) + "/messages/@original", "PATCH")).status).toBe(200);
    expect((await post(f, "https://evil.example/api/v10/channels/1569332852787642459/messages")).status).toBe(200);
    expect((await post(f, "https://discord.com/api/v10/guilds/1561649407584370809/channels")).status).toBe(200);
    expect(faultValue(db)).toBe("rate_limited:5");  // nothing consumed
  });

  it("a malformed row, or a database failure, injects nothing", async () => {
    const db = newDb(); const r = real(); setFault(db, "garbage");
    const f = createFaultFetch("staging", db, r as unknown as typeof fetch)!;
    expect((await post(f)).status).toBe(200);
    const broken = { prepare() { throw new Error("db down"); }, batch: async () => [] };
    const g = createFaultFetch("staging", broken as never, r as unknown as typeof fetch)!;
    expect((await post(g)).status).toBe(200);
  });

  it("overlapping calls cannot over-inject (compare-and-set): one fault, three parallel calls, exactly one 429", async () => {
    const db = newDb(); setFault(db, "rate_limited:1");
    const f = createFaultFetch("staging", db, real() as unknown as typeof fetch)!;
    const statuses = (await Promise.all([post(f), post(f), post(f)])).map((x) => x.status).sort();
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
  });
});

describe("the real client and outbox handle the injected failures", () => {
  const cfg = testConfig();
  const crit: Finding = { component: "source:blizzard-bluepost-us", state: "CRITICAL", reasonCode: "fetch_failing", summary: "x", context: {} };
  async function alert(): Promise<TestDb> { const db = newDb(); await applyFinding(db, crit, T0, cfg.tuning); await ensureOpenNotifications(db, T0); return db; }
  const row = (db: TestDb) => db.rows<{ status: string; attempts: number; next_attempt_at: number; last_error_class: string | null; fallback_sent_at: number | null }>("select status, attempts, next_attempt_at, last_error_class, fallback_sent_at from outbox")[0]!;
  const client = (db: TestDb, r: ReturnType<typeof real>) => new DiscordRestClient({ apiBase: "https://discord.com/api/v10", botToken: "x".repeat(40), fetchFn: createFaultFetch("staging", db, r as unknown as typeof fetch)! });
  const run = (db: TestDb, c: DiscordRestClient, now: number) => processOutbox(db, c, { ...cfg, discord: { ...cfg.discord, alertChannelId: "1569332852787642459" } }, now, captureLog().log);

  it("429: the attempt is given back, Retry-After (20 s) is honoured, nothing is sent, and the next run delivers once", async () => {
    const db = await alert(); const r = real(); setFault(db, "rate_limited:1"); const c = client(db, r);
    const s1 = await run(db, c, T0);
    expect(s1).toMatchObject({ sent: 0, rateLimited: 1, dead: 0 });
    expect(row(db)).toMatchObject({ status: "PENDING", attempts: 0, next_attempt_at: T0 + 20_000, last_error_class: "rate_limited" });
    expect(r).not.toHaveBeenCalled();
    await run(db, c, T0 + 10_000);                  // before Retry-After: untouched
    expect(r).not.toHaveBeenCalled();
    const s2 = await run(db, c, T0 + 300_000);      // next 5-minute cycle
    expect(s2.sent).toBe(1);
    expect(r).toHaveBeenCalledTimes(1);             // exactly one real message
    expect(row(db).status).toBe("SENT");
  });

  it("403: the row goes DEAD at once and is listed for the independent fallback exactly once", async () => {
    const db = await alert(); const r = real(); setFault(db, "forbidden:1"); const c = client(db, r);
    const s = await run(db, c, T0);
    expect(s).toMatchObject({ sent: 0, dead: 1 });
    expect(row(db)).toMatchObject({ status: "DEAD", last_error_class: "auth" });
    expect(r).not.toHaveBeenCalled();
  });
});
