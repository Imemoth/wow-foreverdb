import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { command, harness, type Harness } from "./helpers/harness";
import { healthySnapshot, ok, withSource } from "../src/health/mock-provider";
import { renderIncidentMessage } from "../src/discord/messages";
import { heartbeatHttpLabel } from "../src/discord/handlers";
import { NoopHeartbeat, RecordingHeartbeat, type HeartbeatProvider } from "../src/heartbeat/heartbeat";
import type { IncidentRow } from "../src/incidents/engine";
import { parseToml, type TomlTable } from "./helpers/toml-lite";

const ROOT = new URL("..", import.meta.url).pathname; // ops-bot/
const failingSource = (h: Harness) => h.provider.setFallback(() => ok(withSource(healthySnapshot(h.clock.now()), "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"], consecutiveFailures: 3 })));
const healthyAgain = (h: Harness) => h.provider.setFallback(() => ok(healthySnapshot(h.clock.now())));
const step = async (h: Harness, minutes = 5) => { h.clock.minutes(minutes); return h.cycle(); };
const fieldNames = (call: { body: Record<string, unknown> }) => ((call.body.embeds as Array<{ fields: Array<{ name: string; value: string }> }>)[0]!.fields);

const incident: IncidentRow = {
  id: "INC-261110-TEST", component: "source:blizzard-bluepost-us", status: "RESOLVED", severity: "CRITICAL", reason_code: "fetch_failing", summary: "x",
  context: "{}", first_seen_at: Date.UTC(2026, 10, 10, 7, 0), last_seen_at: Date.UTC(2026, 10, 10, 7, 5), occurrences: 2, healthy_streak: 2, update_count: 0,
  last_notified_at: null, reminder_count: 0, ack_by: null, ack_at: null, ack_note: null, resolved_at: Date.UTC(2026, 10, 10, 7, 15), alert_message_id: null, alert_channel_id: null, updated_at: 0,
} as unknown as IncidentRow;

describe("1. RECOVERED says when the original alert never reached Discord", () => {
  it("renderer: delivered (default) has no note; failed and not_posted each add an 'Original alert' field, only on RECOVERED", () => {
    const names = (m: ReturnType<typeof renderIncidentMessage>) => m.embeds[0]!.fields.map((f) => f.name);
    expect(names(renderIncidentMessage(incident, "RECOVERED", "staging"))).not.toContain("Original alert");
    const failed = renderIncidentMessage(incident, "RECOVERED", "staging", "failed");
    expect(failed.embeds[0]!.fields.find((f) => f.name === "Original alert")!.value).toMatch(/NOT DELIVERED/);
    const notPosted = renderIncidentMessage(incident, "RECOVERED", "staging", "not_posted");
    expect(notPosted.embeds[0]!.fields.find((f) => f.name === "Original alert")!.value).toMatch(/NOT POSTED/);
    expect(names(renderIncidentMessage({ ...incident, status: "OPEN" } as IncidentRow, "OPEN", "staging", "failed"))).not.toContain("Original alert");
  });

  it("end to end: an OPEN alert that went DEAD is announced once on the fallback, stays terminal, and the later RECOVERED is labelled", async () => {
    const h = await harness();
    failingSource(h);
    h.discord.enqueue({ ok: false, class: "auth", status: 403 });
    await h.cycle();                                   // OPEN fails permanently -> DEAD, fallback notice
    for (let i = 0; i < 4; i++) await step(h);         // the source stays critical for 20 more minutes
    expect(h.db.rows<{ status: string; attempts: number }>("select status, attempts from outbox where kind = 'OPEN'")).toEqual([{ status: "DEAD", attempts: 1 }]);
    expect(h.discord.creates).toHaveLength(1);         // DEAD is terminal: never re-sent
    expect(h.fallback.sent).toHaveLength(1);           // and announced exactly once
    healthyAgain(h);
    await step(h); await step(h);                      // two healthy polls
    const recovered = h.discord.creates.at(-1)!;
    expect(h.discord.creates).toHaveLength(2);
    expect(JSON.stringify(recovered.body)).toContain("RECOVERED");
    expect(fieldNames(recovered).find((f) => f.name === "Original alert")!.value).toMatch(/NOT DELIVERED to Discord/);
  });

  it("end to end: when the OPEN alert was delivered, RECOVERED carries no such note", async () => {
    const h = await harness();
    failingSource(h); await h.cycle();
    healthyAgain(h); await step(h); await step(h);
    const recovered = h.discord.creates.at(-1)!;
    expect(JSON.stringify(recovered.body)).toContain("RECOVERED");
    expect(fieldNames(recovered).map((f) => f.name)).not.toContain("Original alert");
  });
});

describe("3. the fault injection is not part of the production bundle", () => {
  const bundle = async (entry: string) => (await build({ entryPoints: [join(ROOT, entry)], bundle: true, write: false, format: "esm", platform: "browser", logLevel: "silent" })).outputFiles[0]!.text;

  it("the production entry bundles no injection code; the staging entry does", async () => {
    const prod = await bundle("src/index.ts");
    const stag = await bundle("src/index.staging.ts");
    for (const marker of ["fault_discord", "rate_limited:", "Missing Access (injected)", "Service unavailable (injected)"]) expect(prod, marker).not.toContain(marker);
    expect(stag).toContain("fault_discord");
    expect(stag).toContain("Missing Access (injected)");
  });

  it("wrangler.toml: production and the top level use src/index.ts, only [env.staging] uses the staging entry", () => {
    const toml = parseToml(readFileSync(join(ROOT, "wrangler.toml"), "utf8"));
    const env = toml.env as { staging: TomlTable; production: TomlTable };
    expect(toml.main).toBe("src/index.ts");
    expect(env.production).not.toHaveProperty("main");   // inherits the top-level (production-safe) entry
    expect(env.staging.main).toBe("src/index.staging.ts");
  });

  it("only the staging entry may import the injection module", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
    const importers = walk(join(ROOT, "src")).filter((f) => /from\s+["'](\.{1,2}\/)+(discord\/)?fault["']/.test(readFileSync(f, "utf8")) && !f.endsWith("src/discord/fault.ts"));
    expect(importers.map((f) => f.replace(ROOT, ""))).toEqual(["src/index.staging.ts"]);
  });

  it("the runtime gate stays as a second line of defence: createFaultFetch is undefined unless BOT_ENV is staging", async () => {
    const { createFaultFetch } = await import("../src/discord/fault");
    const h = await harness();
    expect(createFaultFetch("production", h.db)).toBeUndefined();
  });
});

describe("4. heartbeat: an HTTP acceptance is not independently confirmed receipt", () => {
  const httpState = (h: Harness) => h.db.rows<{ value: string }>("select value from monitor_state where key = 'last_heartbeat_http'")[0]?.value.split("@")[0];
  const provider = (accepted: boolean): HeartbeatProvider => ({ success: async () => accepted, fail: async () => accepted, log: async () => accepted });

  it("a service that answers HTTP 2xx is recorded as 'accepted', one that does not as 'failed', no URL as 'not_configured'", async () => {
    const a = await harness(); a.deps.heartbeat = new RecordingHeartbeat(); await a.cycle(); expect(httpState(a)).toBe("accepted");
    const f = await harness(); f.deps.heartbeat = provider(false); await f.cycle(); expect(httpState(f)).toBe("failed");
    const n = await harness(); n.deps.heartbeat = new NoopHeartbeat(); await n.cycle(); expect(httpState(n)).toBe("not_configured");
  });

  it("the signal the bot chose stays separate (`last_heartbeat`), and a failed ping never breaks the cycle", async () => {
    const h = await harness(); h.deps.heartbeat = provider(false);
    const r = await h.cycle();
    expect(r.status).toBe("completed");
    expect(h.db.rows<{ value: string }>("select value from monitor_state where key = 'last_heartbeat'")[0]!.value).toMatch(/^ok@\d+$/);
  });

  it("a failing ping on the delivery_failing path is also recorded as failed", async () => {
    const h = await harness(); h.deps.heartbeat = provider(false);
    failingSource(h); h.discord.enqueue({ ok: false, class: "auth", status: 403 });
    await h.cycle();
    expect(h.db.rows<{ value: string }>("select value from monitor_state where key = 'last_heartbeat'")[0]!.value).toMatch(/^delivery_failing@/);
    expect(httpState(h)).toBe("failed");
  });

  it("/azerdex status words it honestly", async () => {
    const h = await harness();
    h.deps.heartbeat = new RecordingHeartbeat(); await h.cycle();
    const text = async () => JSON.stringify(await (await h.interact(command("status"))).json());
    expect(await text()).toContain("accepted by the service");
    expect(await text()).toContain("receipt is confirmed only by the external monitor");
    h.deps.heartbeat = provider(false); await step(h);
    expect(await text()).toContain("FAILED (the service did not answer HTTP 2xx)");
    expect(heartbeatHttpLabel(null)).toBe("none yet");
    expect(heartbeatHttpLabel("not_configured@1")).toBe("not configured");
  });
});
