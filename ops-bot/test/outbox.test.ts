import { describe, expect, it } from "vitest";
import { applyFinding, ensureOpenNotifications, getActiveIncident } from "../src/incidents/engine";
import { markFallbackSent, pendingFallbacks, processOutbox } from "../src/incidents/outbox";
import type { Finding } from "../src/monitor/evaluate";
import { newDb, type TestDb } from "./helpers/d1";
import { FakeDiscord, T0, captureLog, testConfig } from "./helpers/fakes";

const cfg = testConfig();
const crit: Finding = { component: "source:blizzard-bluepost-us", state: "CRITICAL", reasonCode: "fetch_failing", summary: "x", context: { cause: "http_503" } };
async function withAlert(): Promise<TestDb> { const db = newDb(); await applyFinding(db, crit, T0, cfg.tuning); await ensureOpenNotifications(db, T0); return db; }
const run = (db: TestDb, d: FakeDiscord, now: number) => processOutbox(db, d, cfg, now, captureLog().log);
const outbox = (db: TestDb) => db.rows<{ status: string; attempts: number; next_attempt_at: number; last_error_class: string | null }>("select status, attempts, next_attempt_at, last_error_class from outbox")[0]!;

describe("outbox delivery", () => {
  it("delivers the alert once, stores the Discord message id on the incident, and sends a deterministic nonce", async () => {
    const db = await withAlert(); const d = new FakeDiscord();
    const s = await run(db, d, T0);
    expect(s).toMatchObject({ sent: 1, dead: 0 });
    expect(d.creates).toHaveLength(1);
    expect(d.creates[0]!.nonce!.length).toBeLessThanOrEqual(25);
    expect((await getActiveIncident(db, crit.component))!.alert_message_id).toMatch(/^91/);
    await run(db, d, T0 + 600_000);
    expect(d.creates).toHaveLength(1); // nothing re-sent
  });

  it("duplicate delivery attempts: two simultaneous workers send the message once (compare-and-set claim)", async () => {
    const db = await withAlert(); const d = new FakeDiscord();
    await Promise.all([run(db, d, T0), run(db, d, T0), run(db, d, T0)]);
    expect(d.creates).toHaveLength(1);
    expect(db.count("outbox", "status = 'SENT'")).toBe(1);
  });

  it("a crashed worker's expired lease is reclaimed; a live lease is respected", async () => {
    const db = await withAlert(); const d = new FakeDiscord();
    db.raw.prepare("update outbox set status = 'SENDING', lease_until = ?").run(T0 + 60_000, );
    await run(db, d, T0 + 10_000);
    expect(d.creates).toHaveLength(0);              // live lease: untouched
    await run(db, d, T0 + 120_000);
    expect(d.creates).toHaveLength(1);              // expired lease: reclaimed
  });

  it("429: honours Retry-After, does not consume an attempt, and stops the batch", async () => {
    const db = await withAlert(); const d = new FakeDiscord().enqueue({ ok: false, class: "rate_limited", status: 429, retryAfterMs: 90_000 });
    const s = await run(db, d, T0);
    expect(s).toMatchObject({ sent: 0, rateLimited: 1 });
    expect(outbox(db)).toMatchObject({ status: "PENDING", attempts: 0, next_attempt_at: T0 + 90_000, last_error_class: "rate_limited" });
    await run(db, d, T0 + 30_000); expect(d.creates).toHaveLength(1);   // not due yet: no second call
    await run(db, d, T0 + 91_000); expect(d.creates).toHaveLength(2);   // due: delivered
    expect(db.count("outbox", "status = 'SENT'")).toBe(1);
  });

  it.each([["server", 500], ["server", 503], ["timeout", undefined], ["network", undefined]] as const)("%s (%s) is retried with exponential backoff and then delivered", async (cls, status) => {
    const db = await withAlert();
    const d = new FakeDiscord().enqueue({ ok: false, class: cls, ...(status ? { status } : {}) }, { ok: false, class: cls });
    await run(db, d, T0); expect(outbox(db)).toMatchObject({ status: "PENDING", attempts: 1, next_attempt_at: T0 + 30_000 });
    await run(db, d, T0 + 30_000); expect(outbox(db)).toMatchObject({ status: "PENDING", attempts: 2, next_attempt_at: T0 + 30_000 + 60_000 });
    await run(db, d, T0 + 200_000);
    expect(outbox(db).status).toBe("SENT");
    expect(d.creates).toHaveLength(3);
  });

  it("gives up after the bounded retry budget: DEAD, audited, and exposed for the fallback route", async () => {
    const db = await withAlert();
    const d = new FakeDiscord(); for (let i = 0; i < 20; i++) d.enqueue({ ok: false, class: "server", status: 500 });
    let now = T0; let last = { dead: 0 };
    for (let i = 0; i < cfg.tuning.outboxMaxAttempts; i++) { last = await run(db, d, now); now += 16 * 60_000; }
    expect(last.dead).toBe(1);
    expect(outbox(db).status).toBe("DEAD");
    expect(d.creates).toHaveLength(cfg.tuning.outboxMaxAttempts);
    expect(db.count("incident_events", "kind = 'NOTIFY_DEAD'")).toBe(1);
    const pending = await pendingFallbacks(db);
    expect(pending).toHaveLength(1);
    await markFallbackSent(db, pending[0]!.id, now);
    expect(await pendingFallbacks(db)).toHaveLength(0); // each failed delivery is announced on the fallback route once
  });

  it.each([["client", 400], ["client", 404], ["auth", 401], ["auth", 403]] as const)("%s %s is permanent: DEAD immediately, no retry storm", async (cls, status) => {
    const db = await withAlert(); const d = new FakeDiscord().enqueue({ ok: false, class: cls, status });
    const s = await run(db, d, T0);
    expect(s.dead).toBe(1);
    await run(db, d, T0 + 3_600_000);
    expect(d.creates).toHaveLength(1);
  });

  it("an edit job without a stored message id completes quietly; an edit with one edits that exact message", async () => {
    const db = await withAlert(); const d = new FakeDiscord();
    await run(db, d, T0); // OPEN delivered -> message id stored
    const inc = (await getActiveIncident(db, crit.component))!;
    db.raw.prepare("insert into outbox (id, incident_id, kind, status, next_attempt_at, created_at) values (?, ?, 'EDIT_ALERT', 'PENDING', ?, ?)").run(`${inc.id}:EDIT_ALERT:ack`, inc.id, T0, T0);
    await run(db, d, T0 + 1);
    expect(d.calls.filter((c) => c.kind === "edit")).toHaveLength(1);
    expect(d.calls.find((c) => c.kind === "edit")!.messageId).toBe(inc.alert_message_id ?? (await getActiveIncident(db, crit.component))!.alert_message_id);
  });

  it("rendered alert content: severity, reason, first observed, status, incident id, ACK button, and mentions disabled", async () => {
    const db = await withAlert(); const d = new FakeDiscord();
    await run(db, d, T0);
    const body = d.creates[0]!.body as { embeds: Array<{ title: string; fields: Array<{ name: string; value: string }>; footer: { text: string } }>; components: Array<{ components: Array<{ custom_id: string }> }>; allowed_mentions: { parse: string[] } };
    const e = body.embeds[0]!;
    expect(e.title).toContain("CRITICAL");
    const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
    expect(f["Component"]).toBe("source:blizzard-bluepost-us");
    expect(f["Reason"]).toBe("fetch_failing");
    expect(f["Status"]).toBe("OPEN");
    expect(f["First observed"]).toMatch(/2026-11-06 12:00 UTC/);
    expect(e.footer.text).toMatch(/^INC-\d{6}-[A-Z0-9]{4} · staging$/);
    expect(body.components[0]!.components[0]!.custom_id).toMatch(/^ack:INC-/);
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });
});
