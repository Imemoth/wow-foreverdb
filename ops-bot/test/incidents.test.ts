import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING } from "../src/config";
import { ackIncident, applyFinding, ensureOpenNotifications, getActiveIncident, purgeExpired } from "../src/incidents/engine";
import type { Finding } from "../src/monitor/evaluate";
import { newDb } from "./helpers/d1";
import { IDS, T0 } from "./helpers/fakes";

const t = DEFAULT_TUNING;
const crit = (reason = "fetch_failing", component = "source:blizzard-bluepost-us"): Finding => ({ component, state: "CRITICAL", reasonCode: reason, summary: `${component}: ${reason}`, context: { cause: "http_503" } });
const healthy = (component = "source:blizzard-bluepost-us"): Finding => ({ component, state: "HEALTHY", reasonCode: "ok", summary: "ok", context: {} });
const state = (component: string, s: Finding["state"]): Finding => ({ component, state: s, reasonCode: "x", summary: "x", context: {} });

describe("incident lifecycle", () => {
  it("opens exactly one incident and one OPEN notification for ten identical critical observations", async () => {
    const db = newDb();
    for (let i = 0; i < 10; i++) { await applyFinding(db, crit(), T0 + i * 300_000, t); await ensureOpenNotifications(db, T0 + i * 300_000); }
    expect(db.count("incidents")).toBe(1);
    expect(db.count("outbox", "kind = 'OPEN'")).toBe(1);
    expect(db.rows<{ occurrences: number }>("select occurrences from incidents")[0]!.occurrences).toBe(10);
  });

  it("converges to a single incident when five invocations race (parallel polling)", async () => {
    const db = newDb();
    await Promise.all(Array.from({ length: 5 }, () => applyFinding(db, crit(), T0, t)));
    await Promise.all(Array.from({ length: 5 }, () => ensureOpenNotifications(db, T0)));
    expect(db.count("incidents")).toBe(1);
    expect(db.count("outbox")).toBe(1);
  });

  it("the database itself refuses a second unresolved incident for the same component", () => {
    const db = newDb();
    const ins = () => db.raw.prepare("insert into incidents (id, component, status, severity, reason_code, summary, first_seen_at, last_seen_at, updated_at) values (?, 'c', 'OPEN', 'CRITICAL', 'r', 's', 1, 1, 1)");
    ins().run("INC-000000-AAAA");
    expect(() => ins().run("INC-000000-BBBB")).toThrow();
    db.raw.prepare("update incidents set status = 'RESOLVED' where id = 'INC-000000-AAAA'").run();
    expect(() => ins().run("INC-000000-CCCC")).not.toThrow(); // a resolved incident does not block a new one
  });

  it("incidents have stable identity: id never changes while the incident is active, even when the reason changes", async () => {
    const db = newDb();
    await applyFinding(db, crit("fetch_failing"), T0, t);
    const id = (await getActiveIncident(db, "source:blizzard-bluepost-us"))!.id;
    await applyFinding(db, crit("persistence_failing"), T0 + 60_000, t);
    expect((await getActiveIncident(db, "source:blizzard-bluepost-us"))!.id).toBe(id);
    expect(id).toMatch(/^INC-\d{6}-[A-Z0-9]{4}$/);
  });

  it("a changed root cause produces exactly one UPDATE notification (meaningful update), not one per poll", async () => {
    const db = newDb();
    await applyFinding(db, crit("fetch_failing"), T0, t); await ensureOpenNotifications(db, T0);
    for (let i = 1; i <= 5; i++) await applyFinding(db, crit("persistence_failing"), T0 + i * 60_000, t);
    expect(db.count("outbox", "kind = 'UPDATE'")).toBe(1);
    expect(db.count("incident_events", "kind = 'UPDATED'")).toBe(1);
  });

  it("throttles reminders: none before the interval, exactly one after, never more than maxReminders", async () => {
    const db = newDb();
    await applyFinding(db, crit(), T0, t); await ensureOpenNotifications(db, T0);
    for (let m = 5; m < 120; m += 5) await applyFinding(db, crit(), T0 + m * 60_000, t);
    expect(db.count("outbox", "kind = 'REMINDER'")).toBe(0);
    for (let m = 120; m <= 600; m += 5) await applyFinding(db, crit(), T0 + m * 60_000, t);
    expect(db.count("outbox", "kind = 'REMINDER'")).toBe(1);
  });

  it("acknowledged incidents are never reminded", async () => {
    const db = newDb();
    await applyFinding(db, crit(), T0, t); await ensureOpenNotifications(db, T0);
    const id = (await getActiveIncident(db, "source:blizzard-bluepost-us"))!.id;
    await ackIncident(db, id, IDS.operator, T0 + 1000, null);
    await applyFinding(db, crit(), T0 + 200 * 60_000, t);
    expect(db.count("outbox", "kind = 'REMINDER'")).toBe(0);
  });

  it("recovery needs consecutive healthy confirmations; a relapse in between resets the streak", async () => {
    const db = newDb();
    await applyFinding(db, crit(), T0, t); await ensureOpenNotifications(db, T0);
    await applyFinding(db, healthy(), T0 + 300_000, t);
    expect((await getActiveIncident(db, "source:blizzard-bluepost-us"))!.healthy_streak).toBe(1);
    await applyFinding(db, crit(), T0 + 600_000, t); // relapse
    expect((await getActiveIncident(db, "source:blizzard-bluepost-us"))!.healthy_streak).toBe(0);
    await applyFinding(db, healthy(), T0 + 900_000, t);
    expect(db.count("incidents", "status = 'RESOLVED'")).toBe(0);
    const tr = await applyFinding(db, healthy(), T0 + 1_200_000, t);
    expect(tr.map((x) => x.kind)).toEqual(["recovered"]);
    expect(db.count("outbox", "kind = 'RECOVERED'")).toBe(1);
  });

  it("repeated healthy observations after resolution never produce more recoveries", async () => {
    const db = newDb();
    await applyFinding(db, crit(), T0, t); await ensureOpenNotifications(db, T0);
    for (let i = 1; i <= 8; i++) await applyFinding(db, healthy(), T0 + i * 300_000, t);
    expect(db.count("outbox", "kind = 'RECOVERED'")).toBe(1);
  });

  it("UNKNOWN fails closed: it neither resolves nor escalates an open incident, and WARNING does not count toward recovery", async () => {
    const db = newDb();
    await applyFinding(db, crit(), T0, t);
    await applyFinding(db, healthy(), T0 + 300_000, t); // streak 1
    for (let i = 2; i < 8; i++) await applyFinding(db, state("source:blizzard-bluepost-us", "UNKNOWN"), T0 + i * 300_000, t);
    expect((await getActiveIncident(db, "source:blizzard-bluepost-us"))!.healthy_streak).toBe(1); // unchanged
    await applyFinding(db, state("source:blizzard-bluepost-us", "WARNING"), T0 + 3_000_000, t);
    expect((await getActiveIncident(db, "source:blizzard-bluepost-us"))!.healthy_streak).toBe(0);
    expect(db.count("incidents", "status = 'RESOLVED'")).toBe(0);
  });

  it("warnings and healthy findings never open an incident", async () => {
    const db = newDb();
    await applyFinding(db, state("source:x", "WARNING"), T0, t);
    await applyFinding(db, healthy("source:x"), T0, t);
    expect(db.count("incidents")).toBe(0);
  });
});

describe("acknowledgement", () => {
  async function open() {
    const db = newDb();
    await applyFinding(db, crit(), T0, t); await ensureOpenNotifications(db, T0);
    return { db, id: (await getActiveIncident(db, "source:blizzard-bluepost-us"))!.id };
  }
  it("records actor and timestamp; the first acknowledgement wins and repeats change nothing", async () => {
    const { db, id } = await open();
    expect((await ackIncident(db, id, IDS.operator, T0 + 5000, "looking")).result).toBe("acked");
    const second = await ackIncident(db, id, IDS.operator2, T0 + 9000, "me too");
    expect(second.result).toBe("already_acked");
    const row = db.rows<{ status: string; ack_by: string; ack_at: number; ack_note: string }>("select status, ack_by, ack_at, ack_note from incidents")[0]!;
    expect(row).toEqual({ status: "ACKNOWLEDGED", ack_by: IDS.operator, ack_at: T0 + 5000, ack_note: "looking" });
    expect(db.count("incident_events", "kind = 'ACK'")).toBe(1);
  });
  it("is atomic under a burst of simultaneous acknowledgements", async () => {
    const { db, id } = await open();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => ackIncident(db, id, `9000000000000001${i}0`, T0 + i, null)));
    expect(rs.filter((r) => r.result === "acked")).toHaveLength(1);
    expect(db.count("incident_events", "kind = 'ACK'")).toBe(1);
  });
  it("cannot acknowledge a resolved or unknown incident", async () => {
    const { db, id } = await open();
    await applyFinding(db, healthy(), T0 + 1, t); await applyFinding(db, healthy(), T0 + 2, t);
    expect((await ackIncident(db, id, IDS.operator, T0 + 3, null)).result).toBe("resolved");
    expect((await ackIncident(db, "INC-000000-ZZZZ", IDS.operator, T0, null)).result).toBe("not_found");
  });
  it("acknowledging never touches health state (component_state and monitor_state are untouched)", async () => {
    const { db, id } = await open();
    db.raw.prepare("insert into component_state values ('source:blizzard-bluepost-us','CRITICAL','fetch_failing',1,1)").run();
    const before = JSON.stringify([db.rows("select * from component_state"), db.rows("select * from monitor_state")]);
    await ackIncident(db, id, IDS.operator, T0 + 5, null);
    expect(JSON.stringify([db.rows("select * from component_state"), db.rows("select * from monitor_state")])).toBe(before);
  });
});

describe("maintenance (notification mute)", () => {
  it("defers the first alert during a mute and sends it once when the mute ends while still critical", async () => {
    const db = newDb();
    db.raw.prepare("insert into maintenance (component, starts_at, ends_at, created_by, reason) values ('source:blizzard-bluepost-us', ?, ?, ?, 'planned')").run(T0 - 1000, T0 + 3_600_000, IDS.operator);
    await applyFinding(db, crit(), T0, t); await ensureOpenNotifications(db, T0);
    expect(db.count("incidents")).toBe(1);        // monitoring continues
    expect(db.count("outbox")).toBe(0);           // notification muted
    await ensureOpenNotifications(db, T0 + 600_000);
    expect(db.count("incident_events", "kind = 'NOTIFY_SUPPRESSED'")).toBe(1); // recorded once, not per poll
    await ensureOpenNotifications(db, T0 + 4_000_000); // mute expired
    expect(db.count("outbox", "kind = 'OPEN'")).toBe(1);
  });
  it("a wildcard mute covers every component; an incident that recovers during the mute produces no orphan recovery message", async () => {
    const db = newDb();
    db.raw.prepare("insert into maintenance (component, starts_at, ends_at, created_by, reason) values ('*', ?, ?, ?, 'planned')").run(T0 - 1000, T0 + 3_600_000, IDS.operator);
    await applyFinding(db, crit(), T0, t); await ensureOpenNotifications(db, T0);
    await applyFinding(db, healthy(), T0 + 1, t); await applyFinding(db, healthy(), T0 + 2, t);
    expect(db.count("outbox")).toBe(0);
    expect(db.count("incidents", "status = 'RESOLVED'")).toBe(1);
  });
});

describe("self-healing and retention", () => {
  it("an incident whose notification was never queued (crash window) is notified by the next cycle", async () => {
    const db = newDb();
    await applyFinding(db, crit(), T0, t); // crash here: no ensureOpenNotifications
    expect(db.count("outbox")).toBe(0);
    expect(await ensureOpenNotifications(db, T0 + 300_000)).toHaveLength(1);
    expect(await ensureOpenNotifications(db, T0 + 600_000)).toHaveLength(0); // idempotent
  });
  it("bounded retention: resolved incidents past the window are purged with their events and outbox rows; active ones are kept", async () => {
    const db = newDb();
    await applyFinding(db, crit("a", "source:old"), T0, t); await ensureOpenNotifications(db, T0);
    await applyFinding(db, healthy("source:old"), T0 + 1, t); await applyFinding(db, healthy("source:old"), T0 + 2, t);
    await applyFinding(db, crit("b", "source:active"), T0, t);
    await purgeExpired(db, T0 + 89 * 86_400_000, t);
    expect(db.count("incidents")).toBe(2);
    await purgeExpired(db, T0 + 91 * 86_400_000, t);
    expect(db.count("incidents")).toBe(1);
    expect(db.count("incidents", "component = 'source:active'")).toBe(1);
    expect(db.count("incident_events", "incident_id not in (select id from incidents)")).toBe(0);
    expect(db.count("outbox", "incident_id not in (select id from incidents)")).toBe(0);
  });
});
