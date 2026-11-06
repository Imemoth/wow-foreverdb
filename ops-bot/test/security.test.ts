import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLogger, pseudonym, redact, redactString } from "../src/util/log";
import { sanitizeText } from "../src/util/text";
import { COMMAND_DEFINITIONS } from "../src/discord/commands";
import { healthySnapshot, ok, withSource } from "../src/health/mock-provider";
import worker from "../src/index";
import { button, command, harness, str } from "./helpers/harness";
import { IDS, newId } from "./helpers/security-helpers";
import { newDb } from "./helpers/d1";

const ROOT = new URL("..", import.meta.url).pathname;
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe("no personal data or secrets in logs, payloads or messages", () => {
  it("a full incident scenario (alerts, acks, denials, delivery failures, reporting outage) leaks no canary secret, URL or operator id into logs or Discord payloads", async () => {
    const SECRETS = ["TEST_BOT_TOKEN_CANARY_aaaaaaaaaaaaaaaaaaaaaaaa", "CANARY-HEARTBEAT-UUID", "CANARY-FALLBACK-TOKEN", "CANARY_HEALTH_SECRET"];
    const h = await harness({ heartbeatUrl: "https://hc.example/ping/CANARY-HEARTBEAT-UUID", fallbackUrl: "https://fb.example/CANARY-FALLBACK-TOKEN", health: { kind: "http", url: "https://reports.example/h", secret: "CANARY_HEALTH_SECRET".padEnd(40, "x") } });
    h.provider.setFallback(() => ok(withSource(healthySnapshot(h.clock.now()), "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"] })));
    h.discord.enqueue({ ok: false, class: "server", status: 500 }, { ok: false, class: "rate_limited", status: 429, retryAfterMs: 5000 });
    for (let i = 0; i < 4; i++) { await h.cycle(); h.clock.minutes(16); }
    const id = h.db.rows<{ id: string }>("select id from incidents")[0]!.id;
    await h.interact(command("ack", [str("id", id)]));
    await h.interact(command("status", [], { userId: IDS.stranger }));
    await h.interact(button(`ack:${id}`, { userId: IDS.stranger }));
    await h.interact({ id: newId(), application_id: IDS.app, type: 1 }, { sig: "ab".repeat(64) });
    h.provider.setFallback(() => ({ ok: false, failure: "server", httpStatus: 500 }));
    for (let i = 0; i < 5; i++) { await h.cycle(); h.clock.minutes(5); }
    const logs = h.lines.join("\n");
    const payloads = JSON.stringify(h.discord.calls);
    expect(logs.length).toBeGreaterThan(100);
    for (const s of SECRETS) { expect(logs).not.toContain(s); expect(payloads).not.toContain(s); }
    for (const uid of [IDS.operator, IDS.operator2, IDS.stranger]) expect(logs).not.toContain(uid);   // operator ids are pseudonymised in logs
    expect(logs).not.toMatch(/https?:\/\//);
    expect(logs).toMatch(/u_[0-9a-f]{8}/);                                                            // but still correlatable
  });

  it("redaction: sensitive keys, webhook URLs, bot/bearer tokens, hex blobs, mentions, long tokens", () => {
    const out = JSON.stringify(redact({ authorization: "Bot abcdefghijklmnopqrstuvwxyz", webhookUrl: "https://discord.com/api/webhooks/1/AAA", password: "hunter2", nested: { api_key: "k", note: "see https://discord.com/api/webhooks/123456/TOKENVALUE and <@123456789012345678> and Bearer abcdefgh12345678 and " + "a".repeat(64) }, actor: IDS.operator }));
    for (const leaked of ["abcdefghijklmnopqrstuvwxyz", "AAA", "hunter2", "TOKENVALUE", "123456789012345678", "abcdefgh12345678", "a".repeat(64), IDS.operator]) expect(out).not.toContain(leaked);
    expect(out).toContain(pseudonym(IDS.operator));
  });
  it("redaction is bounded (depth, array and object size, string length)", () => {
    const deep = JSON.stringify(redact({ a: { b: { c: { d: { e: { f: 1 } } } } } }));
    expect(deep).toContain("[TRUNCATED]");
    expect((redact(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(20);
    expect(redactString("x".repeat(1000)).length).toBeLessThanOrEqual(301);
  });
  it("the logger writes one JSON line per event and redacts event names too", () => {
    const lines: string[] = []; const log = createLogger((l) => lines.push(l), () => 0);
    log.error("failed https://discord.com/api/webhooks/1/SECRETTOKEN", { token: "t" });
    expect(lines).toHaveLength(1); expect(JSON.parse(lines[0]!).level).toBe("error"); expect(lines[0]).not.toContain("SECRETTOKEN");
  });
  it("sanitizeText strips mentions, markup and control characters and bounds length", () => {
    const s = sanitizeText("@everyone <@123> <#456> \u0000‮hidden\nline " + "z".repeat(500), 100);
    expect(s).not.toMatch(/@everyone|<@|<#|\u0000|‮/); expect(s.length).toBeLessThanOrEqual(100);
  });
});

describe("static guarantees: the bot cannot reach or change anything outside its own scope", () => {
  const sources = walk(join(ROOT, "src")).map((p) => ({ p, s: readFileSync(p, "utf8") }));
  it("source contains no database credential, no Supabase admin/service-role access, no cron or News write paths", () => {
    const forbidden = [/service_role/i, /postgres(ql)?:\/\//i, /SUPABASE_DB_URL/i, /cron\.(schedule|unschedule|alter_job)/i, /news_link_stories/i, /AZERDEX_NEWS_BACKFILL/i, /pub_admin/i, /\bpub\.news_/i, /collector[_-]?secret/i, /create_edge_function_secret/i];
    for (const { p, s } of sources) for (const re of forbidden) expect(s, `${p} matches ${re}`).not.toMatch(re);
  });
  it("the health provider interface is read-only: fetchSnapshot is its only method", () => {
    const iface = readFileSync(join(ROOT, "src/health/provider.ts"), "utf8").match(/export interface HealthProvider \{([^}]*)\}/)![1]!;
    expect([...iface.matchAll(/(\w+)\(/g)].map((m) => m[1])).toEqual(["fetchSnapshot"]);
  });
  it("the only HTTP verbs used toward Supabase are GET; Discord usage is limited to POST/PATCH of messages", () => {
    const http = readFileSync(join(ROOT, "src/health/http-provider.ts"), "utf8");
    expect(http).toMatch(/method: "GET"/); expect(http).not.toMatch(/method: "(POST|PUT|PATCH|DELETE)"/);
    const discord = readFileSync(join(ROOT, "src/discord/client.ts"), "utf8");
    expect([...new Set([...discord.matchAll(/this\.call\("(\w+)"/g)].map((m) => m[1]))].sort()).toEqual(["PATCH", "POST"]);
  });
  it("only the logger and the worker entry may touch console", () => {
    for (const { p, s } of sources) if (!/util\/log\.ts$/.test(p)) expect(s, p).not.toMatch(/console\./);
  });
  it("slash commands are read/acknowledge only and hidden by default", () => {
    const names = JSON.stringify(COMMAND_DEFINITIONS);
    for (const verb of ["restart", "deploy", "backfill", "rotate", "delete", "run", "execute", "sql"]) expect(names.toLowerCase()).not.toContain(`"name":"${verb}`);
    const def = COMMAND_DEFINITIONS[0]!;
    expect(def.default_member_permissions).toBe("0"); expect(def.dm_permission).toBe(false);
    expect(def.options.map((o) => o.name)).toEqual(["status", "incidents", "incident", "ack", "maintenance"]);
  });
  it("wrangler.toml: no default environment, no secrets, placeholders only, separate staging and production resources", () => {
    const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
    expect(toml).toMatch(/^\[env\.staging\]/m); expect(toml).toMatch(/^\[env\.production\]/m);
    expect(toml.split(/^\[env\./m)[0]).not.toMatch(/d1_databases|crons|\[vars\]/);   // nothing deployable at the top level
    expect(toml).toContain("REPLACE_WITH_STAGING_D1_ID"); expect(toml).toContain("REPLACE_WITH_PRODUCTION_D1_ID");
    expect(toml).not.toMatch(/(token|secret|password|api_key|public_key|webhook)\s*=/i);
    expect(toml).toMatch(/BOT_ENV = "staging"/); expect(toml).toMatch(/BOT_ENV = "production"/);
    expect(toml).toMatch(/HEALTH_PROVIDER = "mock"/); expect(toml).toMatch(/HEALTH_PROVIDER = "http"/);
  });
  it("no file in the ops-bot tree contains something that looks like a real credential", () => {
    const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "migrations")), join(ROOT, "wrangler.toml"), join(ROOT, "package.json")];
    for (const p of files) {
      const s = readFileSync(p, "utf8");
      expect(s, p).not.toMatch(/https:\/\/discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/);
      expect(s, p).not.toMatch(/\b[MNO][A-Za-z\d_-]{23,25}\.[\w-]{6}\.[\w-]{27,}\b/); // Discord bot token shape
      expect(s, p).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });
});

describe("worker entry fails closed", () => {
  const ctx = { waitUntil: (_p: Promise<unknown>) => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  it("/healthz is liveness only: no state, no configuration echo; unknown paths 404", async () => {
    const r = await worker.fetch(new Request("https://bot/healthz"), {}, ctx);
    expect(await r.json()).toEqual({ ok: true });
    expect((await worker.fetch(new Request("https://bot/anything"), {}, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://bot/healthz", { method: "POST" }), {}, ctx)).status).toBe(404);
  });
  it("an unconfigured worker answers 503 to interactions without echoing anything", async () => {
    const r = await worker.fetch(new Request("https://bot/interactions", { method: "POST", body: "{}" }), {}, ctx);
    expect(r.status).toBe(503); expect(await r.json()).toEqual({ error: "service_unavailable" });
  });
  it("a misconfigured scheduled run still signals the independent heartbeat with /fail, then throws", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { calls.push(String(u)); return new Response("OK"); });
    await expect(worker.scheduled({} as ScheduledController, { HEARTBEAT_PING_URL: "https://hc.example/ping/uuid" } as never, ctx)).rejects.toThrow();
    vi.unstubAllGlobals();
    expect(calls).toEqual(["https://hc.example/ping/uuid/fail"]);
  });
  it("a misconfigured scheduled run without a valid heartbeat URL still throws (cron execution fails visibly in Cloudflare)", async () => {
    await expect(worker.scheduled({} as ScheduledController, {} as never, ctx)).rejects.toThrow();
  });
});

describe("rollback of every newly introduced component", () => {
  it("the down migration removes exactly the tables the up migration created, nothing else, and is idempotent", () => {
    const db = new (newDb().constructor as new () => ReturnType<typeof newDb>)();
    const before = db.tables();
    expect(before).toEqual([]);
    db.raw.exec("create table news_entries_sentinel (id integer primary key, title text)");
    db.raw.exec("insert into news_entries_sentinel values (1, 'untouched')");
    db.migrate();
    const created = db.tables().filter((t) => t !== "news_entries_sentinel");
    expect(created).toEqual(["audit_log", "component_state", "incident_events", "incidents", "locks", "maintenance", "monitor_state", "outbox", "rate_limits", "seen_interactions"]);
    db.rollback();
    expect(db.tables()).toEqual(["news_entries_sentinel"]);
    expect(db.rows("select * from news_entries_sentinel")).toEqual([{ id: 1, title: "untouched" }]);
    expect(() => db.rollback()).not.toThrow();      // idempotent
    db.migrate();                                     // and re-applicable
    expect(db.tables().length).toBe(created.length + 1);
  });
  it("the schema is isolated from News: no table name or column references a News/publication table", () => {
    const sql = readFileSync(join(ROOT, "migrations/0001_ops_bot_init.sql"), "utf8").replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bnews_|pub\.|pub_admin|web_api|references\s+(?!incidents)/i);
  });
  it("rolling back the bot leaves the repository's other components untouched: the ops-bot directory is self-contained", () => {
    const files = walk(ROOT).filter((p) => !p.includes("node_modules"));
    expect(files.every((p) => p.startsWith(ROOT))).toBe(true);
    for (const p of files.filter((f) => f.endsWith(".ts"))) expect(readFileSync(p, "utf8"), p).not.toMatch(/from ["'](\.\.\/){3,}/); // nothing imports outside ops-bot/
  });
});
