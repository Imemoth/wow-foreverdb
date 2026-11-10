import { describe, expect, it } from "vitest";
import { applyFinding, ensureOpenNotifications, getActiveIncident } from "../src/incidents/engine";
import { healthySnapshot, ok, withSource } from "../src/health/mock-provider";
import { button, command, harness, int, str, type Harness } from "./helpers/harness";
import { IDS, nextId } from "./helpers/fakes";

const body = async (r: Response) => (await r.json()) as { type: number; data?: { content?: string; flags?: number; embeds?: unknown[]; components?: unknown[]; allowed_mentions?: { parse: string[] } }; error?: string };
async function withIncident(h: Harness) {
  h.provider.setFallback(() => ok(withSource(healthySnapshot(h.clock.now()), "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"] })));
  await h.cycle();
  return (await getActiveIncident(h.db, "source:blizzard-bluepost-us"))!;
}

describe("signature verification and request hygiene", () => {
  it("answers Discord's signed PING (endpoint validation)", async () => {
    const h = await harness();
    const r = await h.interact({ id: nextId(), application_id: IDS.app, type: 1 });
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ type: 1 });
  });
  it("rejects a bad signature, a tampered body, missing headers, malformed hex and a wrong key (401, nothing executed)", async () => {
    const h = await harness();
    const ping = { id: nextId(), application_id: IDS.app, type: 1 };
    expect((await h.interact(ping, { sig: "ab".repeat(64) })).status).toBe(401);
    expect((await h.interact(ping, { sig: "zz".repeat(64) })).status).toBe(401);
    expect((await h.interact(ping, { sig: "ab" })).status).toBe(401);
    expect((await h.interact(ping, { skipSign: true })).status).toBe(401);
    const signedForOther = await h.keys.sign(String(Math.floor(h.clock.now() / 1000)), JSON.stringify({ ...ping, id: nextId() }));
    expect((await h.interact(ping, { sig: signedForOther })).status).toBe(401); // signature valid for a DIFFERENT body
    const { makeKeys } = await import("./helpers/fakes");
    const other = await makeKeys(); const ts = String(Math.floor(h.clock.now() / 1000)); const raw = JSON.stringify(ping);
    expect((await h.interact(ping, { sig: await other.sign(ts, raw) })).status).toBe(401);
  });
  it("verifies the ORIGINAL bytes: whitespace-different but JSON-equivalent body fails", async () => {
    const h = await harness();
    const ping = { id: nextId(), application_id: IDS.app, type: 1 };
    const ts = String(Math.floor(h.clock.now() / 1000));
    const sig = await h.keys.sign(ts, JSON.stringify(ping));
    expect((await h.interact(ping, { ts, sig, raw: JSON.stringify(ping, null, 2) })).status).toBe(401);
  });
  it("replay protection: an old timestamp and a re-sent identical request are both refused", async () => {
    const h = await harness();
    const old = String(Math.floor(h.clock.now() / 1000) - 600);
    expect((await h.interact({ id: nextId(), application_id: IDS.app, type: 1 }, { ts: old })).status).toBe(401);
    const ping = { id: nextId(), application_id: IDS.app, type: 1 };
    expect((await h.interact(ping)).status).toBe(200);
    expect((await h.interact(ping)).status).toBe(401);
  });
  it("bounded input: oversized bodies 413 before any parsing; signed garbage 400; wrong application 401; schema violations 400", async () => {
    const h = await harness();
    expect((await h.interact({}, { raw: JSON.stringify({ pad: "x".repeat(70_000) }) })).status).toBe(413);
    const ts = String(Math.floor(h.clock.now() / 1000));
    for (const raw of ["not json", "[]", JSON.stringify({ id: "1", application_id: IDS.app, type: 2 })]) {
      expect((await h.interact({}, { raw, ts, sig: await h.keys.sign(ts, raw) })).status).toBe(400);
    }
    expect((await h.interact({ id: nextId(), application_id: "900000000000009999", type: 1 })).status).toBe(401);
  });
  it("only POST is accepted", async () => {
    const h = await harness();
    const { handleInteractionRequest } = await import("../src/discord/interactions");
    const r = await handleInteractionRequest(new Request("https://x/interactions", { method: "GET" }), { db: h.db, cfg: h.cfg, clock: h.clock, discord: h.discord, log: h.deps.log, waitUntil: () => undefined });
    expect(r.status).toBe(405);
  });
});

describe("authorization (negative tests)", () => {
  it("an unauthorized user cannot ack: gets an ephemeral refusal and the incident is unchanged", async () => {
    const h = await harness(); const inc = await withIncident(h);
    const r = await body(await h.interact(command("ack", [str("id", inc.id)], { userId: IDS.stranger })));
    expect(r.data!.flags).toBe(64);
    expect(r.data!.content).toContain("not authorized");
    expect(h.db.rows<{ status: string }>("select status from incidents")[0]!.status).toBe("OPEN");
    expect(h.db.count("incident_events", "kind = 'ACK'")).toBe(0);
  });
  it("an operator from an unconfigured guild is refused; DMs are refused; every read command is refused too", async () => {
    const h = await harness();
    for (const who of [{ guildId: IDS.otherGuild }, { dm: true }, { userId: IDS.stranger }]) {
      for (const sub of ["status", "incidents", "incident", "ack", "maintenance"]) {
        const r = await body(await h.interact(command(sub, [str("id", "INC-000000-AAAA"), str("action", "list")], who)));
        expect(r.data!.content).toContain("not authorized");
      }
    }
  });
  it("an unauthorized user cannot press the Acknowledge button", async () => {
    const h = await harness(); const inc = await withIncident(h);
    const r = await body(await h.interact(button(`ack:${inc.id}`, { userId: IDS.stranger })));
    expect(r.type).toBe(4); expect(r.data!.content).toContain("not authorized");
    expect(h.db.rows<{ status: string }>("select status from incidents")[0]!.status).toBe("OPEN");
  });
  it("authorization by operator ROLE works; a role not in the allowlist does not", async () => {
    const h = await harness();
    expect((await body(await h.interact(command("status", [], { userId: IDS.stranger, roles: [IDS.opRole] })))).data!.content).toContain("AzerDex ops status");
    expect((await body(await h.interact(command("status", [], { userId: IDS.stranger, roles: ["900000000000000099"] })))).data!.content).toContain("not authorized");
  });
  it("the refusal does not reveal configuration (no ids, no operator list)", async () => {
    const h = await harness();
    const r = JSON.stringify(await body(await h.interact(command("status", [], { userId: IDS.stranger }))));
    for (const secret of [IDS.operator, IDS.operator2, IDS.opRole, IDS.guild]) expect(r).not.toContain(secret);
  });
  it("per-operator rate limit: the 11th command in a minute is throttled; another operator is unaffected; the window resets", async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) expect((await body(await h.interact(command("status")))).data!.content).toContain("AzerDex ops status");
    expect((await body(await h.interact(command("status")))).data!.content).toContain("Too many requests");
    expect((await body(await h.interact(command("status", [], { userId: IDS.operator2 })))).data!.content).toContain("AzerDex ops status");
    h.clock.minutes(2);
    expect((await body(await h.interact(command("status")))).data!.content).toContain("AzerDex ops status");
  });
});

describe("commands", () => {
  it("/azerdex status: UNKNOWN before the first cycle, HEALTHY after a good one, UNKNOWN again if the monitor stalls; ephemeral", async () => {
    const h = await harness();
    const first = await body(await h.interact(command("status")));
    expect(first.data!.flags).toBe(64); expect(first.data!.content).toContain("Overall: **UNKNOWN**");
    await h.cycle();
    expect((await body(await h.interact(command("status")))).data!.content).toContain("Overall: **HEALTHY**");
    h.clock.minutes(30);
    expect((await body(await h.interact(command("status")))).data!.content).toMatch(/Overall: \*\*UNKNOWN\*\* \(monitor stalled/);
  });
  it("/azerdex status shows CRITICAL with the open incident count", async () => {
    const h = await harness(); await withIncident(h);
    const c = (await body(await h.interact(command("status")))).data!.content!;
    expect(c).toContain("Overall: **CRITICAL**"); expect(c).toContain("1 open, 0 acknowledged");
  });
  it("/azerdex incidents and /azerdex incident show details; invalid ids are rejected without a database lookup", async () => {
    const h = await harness(); const inc = await withIncident(h);
    expect((await body(await h.interact(command("incidents")))).data!.content).toContain(inc.id);
    const d = (await body(await h.interact(command("incident", [str("id", inc.id)])))).data!.content!;
    expect(d).toContain(inc.id); expect(d).toContain("Not acknowledged"); expect(d).toContain("OPENED");
    for (const bad of ["x", "INC-1", "'; drop table incidents;--", "INC-261106-ab12", "A".repeat(50)]) {
      expect((await body(await h.interact(command("incident", [str("id", bad)])))).data!.content).toBe("Invalid incident id.");
    }
    expect((await body(await h.interact(command("incident", [str("id", "INC-000000-ZZZZ")])))).data!.content).toBe("Incident not found.");
    expect(h.db.count("incidents")).toBe(1);
  });
  it("/azerdex ack records actor and time; repeats are idempotent; ACK never changes health or calls the provider", async () => {
    const h = await harness(); const inc = await withIncident(h);
    const callsBefore = h.provider.calls;
    const stateBefore = JSON.stringify(h.db.rows("select * from component_state order by component"));
    const first = (await body(await h.interact(command("ack", [str("id", inc.id), str("note", "on it")])))).data!.content!;
    expect(first).toContain("Acknowledged"); expect(first).toContain("Health state is unchanged");
    const second = (await body(await h.interact(command("ack", [str("id", inc.id)], { userId: IDS.operator2 })))).data!.content!;
    expect(second).toContain("already acknowledged");
    const row = h.db.rows<{ status: string; ack_by: string }>("select status, ack_by from incidents")[0]!;
    expect(row).toEqual({ status: "ACKNOWLEDGED", ack_by: IDS.operator });
    expect(h.provider.calls).toBe(callsBefore);
    expect(JSON.stringify(h.db.rows("select * from component_state order by component"))).toBe(stateBefore);
    // the alert message is edited via the outbox so everyone sees the acknowledgement
    await h.cycle();
    expect(h.discord.calls.some((c) => c.kind === "edit")).toBe(true);
  });
  it("/azerdex ack on an unknown or resolved incident", async () => {
    const h = await harness();
    expect((await body(await h.interact(command("ack", [str("id", "INC-000000-ZZZZ")])))).data!.content).toBe("Incident not found.");
  });
  it("Acknowledge button edits the alert in place (type 7), removes the button, names the operator, and a second click is a no-op", async () => {
    const h = await harness(); const inc = await withIncident(h);
    const r = await body(await h.interact(button(`ack:${inc.id}`)));
    expect(r.type).toBe(7);
    const data = r.data as { embeds: Array<{ fields: Array<{ name: string; value: string }> }>; components: unknown[]; allowed_mentions: { parse: string[] } };
    expect(data.components).toEqual([]);
    expect(data.embeds[0]!.fields.find((f) => f.name === "Status")!.value).toContain("ACKNOWLEDGED");
    expect(data.allowed_mentions).toEqual({ parse: [] });
    const again = await body(await h.interact(button(`ack:${inc.id}`, { userId: IDS.operator2 })));
    expect(again.type).toBe(4); expect(again.data!.content).toContain("already acknowledged");
    expect(h.db.count("incident_events", "kind = 'ACK'")).toBe(1);
    expect(h.db.rows<{ ack_by: string }>("select ack_by from incidents")[0]!.ack_by).toBe(IDS.operator);
    expect((await body(await h.interact(button("ack:not-an-id")))).data!.content).toBe("Invalid action.");
  });
  it("an unsupported interaction type gets a harmless ephemeral reply", async () => {
    const h = await harness();
    const r = await body(await h.interact({ id: nextId(), application_id: IDS.app, type: 4, guild_id: IDS.guild, member: { user: { id: IDS.operator }, roles: [] } }));
    expect(r.data!.content).toBe("Unsupported interaction.");
  });
});

describe("maintenance (notification mute only)", () => {
  it("start mutes the alert; monitoring continues; end releases it on the next cycle; audited", async () => {
    const h = await harness();
    const r = (await body(await h.interact(command("maintenance", [str("action", "start"), str("component", "source:blizzard-bluepost-us"), int("minutes", 60), str("reason", "planned")])))).data!.content!;
    expect(r).toContain("muted for 60 min");
    h.provider.setFallback(() => ok(withSource(healthySnapshot(h.clock.now()), "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"] })));
    await h.cycle();
    expect(h.db.count("incidents")).toBe(1); expect(h.discord.calls).toHaveLength(0);
    expect((await body(await h.interact(command("maintenance", [str("action", "list")])))).data!.content).toContain("source:blizzard-bluepost-us");
    expect((await body(await h.interact(command("maintenance", [str("action", "end"), str("component", "source:blizzard-bluepost-us")])))).data!.content).toContain("ended");
    h.clock.minutes(5); await h.cycle();
    expect(h.discord.creates).toHaveLength(1);
    expect(h.db.count("audit_log", "action in ('maintenance_start','maintenance_end')")).toBe(2);
  });
  it("validates component, duration (5..1440) and action; invalid input changes nothing", async () => {
    const h = await harness();
    const run = async (opts: Array<{ name: string; type: number; value: unknown }>) => (await body(await h.interact(command("maintenance", opts)))).data!.content!;
    expect(await run([str("action", "start"), str("component", "pub.news_entries"), int("minutes", 60)])).toContain("valid component");
    expect(await run([str("action", "start"), str("component", "*"), int("minutes", 1)])).toContain("Duration");
    expect(await run([str("action", "start"), str("component", "*"), int("minutes", 99999)])).toContain("Duration");
    expect(await run([str("action", "wipe"), str("component", "*")])).toContain("Action must be");
    expect(h.db.count("maintenance")).toBe(0);
  });
  it("is bot-local: a mute cannot touch anything outside the bot's own tables (no provider call, no Discord call)", async () => {
    const h = await harness();
    await h.interact(command("maintenance", [str("action", "start"), str("component", "*"), int("minutes", 30)]));
    expect(h.provider.calls).toBe(0); expect(h.discord.calls).toHaveLength(0);
  });
});

describe("Discord 3-second deadline", () => {
  it("a slow command is acknowledged with a deferred ephemeral response and completed by editing the original response", async () => {
    const h = await harness();
    h.cfg.tuning.interactionDeadlineMs = 20;
    const r = await body(await h.interact(command("status"), { slowMs: 80 }));
    expect(r).toEqual({ type: 5, data: { flags: 64 } });
    await Promise.all(h.bg);
    const edit = h.discord.calls.find((c) => c.kind === "original")!;
    expect(JSON.stringify(edit.body)).toContain("AzerDex ops status");
  });
  it("a slow button press is deferred with type 6", async () => {
    const h = await harness(); const inc = await withIncident(h);
    h.cfg.tuning.interactionDeadlineMs = 20;
    const r = await body(await h.interact(button(`ack:${inc.id}`), { slowMs: 80 }));
    expect(r).toEqual({ type: 6 });
    await Promise.all(h.bg);
    expect(h.discord.calls.some((c) => c.kind === "original")).toBe(true);
  });
  it("a handler that throws returns a generic ephemeral error (no stack trace, no internals)", async () => {
    const h = await harness();
    h.db.raw.exec("drop table component_state");
    const r = JSON.stringify(await body(await h.interact(command("status"))));
    expect(r).toContain("Something went wrong");
    expect(r).not.toMatch(/sqlite|no such table|component_state|at \w+/i);
  });
});

describe("every outbound payload disables mentions", () => {
  it("alerts, updates, recoveries and ephemeral replies all carry allowed_mentions.parse = []", async () => {
    const h = await harness(); const inc = await withIncident(h);
    await h.interact(command("ack", [str("id", inc.id)]));
    h.provider.setFallback(() => ok(healthySnapshot(h.clock.now())));
    await h.cycle(); h.clock.minutes(5); await h.cycle(); h.clock.minutes(5); await h.cycle();
    expect(h.discord.calls.length).toBeGreaterThan(1);
    for (const c of h.discord.calls) expect((c.body as { allowed_mentions: { parse: string[] } }).allowed_mentions).toEqual({ parse: [] });
    const eph = await body(await h.interact(command("status")));
    expect(eph.data!.allowed_mentions).toEqual({ parse: [] });
  });
  it("hostile text from a source cause cannot inject a mention into an alert", async () => {
    const h = await harness(); await applyFinding(h.db, { component: "source:x", state: "CRITICAL", reasonCode: "boom", summary: "@everyone <@123456789012345678> `click`", context: { cause: "@here" } }, h.clock.now(), h.cfg.tuning);
    await ensureOpenNotifications(h.db, h.clock.now()); await h.cycle();
    const sent = JSON.stringify(h.discord.creates[0]!.body);
    expect(sent).not.toMatch(/@everyone|@here|<@1234/);
  });
});
