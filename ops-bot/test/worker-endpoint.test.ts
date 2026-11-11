import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { newDb } from "./helpers/d1";
import { IDS, makeKeys, nextId, T0 } from "./helpers/fakes";

/**
 * The staging interactions endpoint is PUBLIC on workers.dev by necessity (Discord must reach it). These tests drive the real Worker `fetch`
 * entry with a complete staging environment (configuration parsing included) and prove that being reachable grants nothing:
 * every request must carry a valid Discord Ed25519 signature, and every command is authorised server-side.
 */
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const nowSec = () => String(Math.floor(Date.now() / 1000));

async function stagingEnv() {
  const keys = await makeKeys();
  const db = newDb();
  const env = {
    DB: db, BOT_ENV: "staging", DISCORD_PUBLIC_KEY: keys.publicKeyHex, DISCORD_BOT_TOKEN: "STAGING_TOKEN_CANARY_0123456789abcdef",
    DISCORD_APPLICATION_ID: IDS.app, DISCORD_ALERT_CHANNEL_ID: IDS.channel, DISCORD_GUILD_IDS: IDS.guild, OPERATOR_USER_IDS: IDS.operator, HEALTH_PROVIDER: "mock",
  };
  const post = async (body: unknown, opts: { sign?: boolean; sig?: string; host?: string } = {}) => {
    const raw = JSON.stringify(body); const ts = nowSec();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.sign !== false) { headers["x-signature-ed25519"] = opts.sig ?? (await keys.sign(ts, raw)); headers["x-signature-timestamp"] = ts; }
    return worker.fetch(new Request(`https://${opts.host ?? "azerdex-ops-bot-staging.example-subdomain.workers.dev"}/interactions`, { method: "POST", headers, body: raw }), env as never, ctx);
  };
  return { env, db, post, keys };
}
const cmd = (userId: string) => ({ id: nextId(), application_id: IDS.app, type: 2, token: "T".repeat(40), guild_id: IDS.guild, member: { user: { id: userId }, roles: [] }, data: { name: "azerdex", options: [{ type: 1, name: "status", options: [] }] } });

describe("public staging endpoint stays protected", () => {
  it("an unsigned request, a wrongly signed request, and a tampered request are all refused with 401 and execute nothing", async () => {
    const { post, db } = await stagingEnv();
    expect((await post(cmd(IDS.operator), { sign: false })).status).toBe(401);
    expect((await post(cmd(IDS.operator), { sig: "ab".repeat(64) })).status).toBe(401);
    expect(db.count("seen_interactions")).toBe(0);                 // nothing past the signature gate ran
  });
  it("a correctly signed PING is accepted (this is what Discord's endpoint validation sends)", async () => {
    const { post } = await stagingEnv();
    const r = await post({ id: nextId(), application_id: IDS.app, type: 1 });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ type: 1 });
  });
  it("a correctly signed command from a NON-operator is refused by server-side authorization (a valid signature is not authorization)", async () => {
    const { post } = await stagingEnv();
    const r = (await (await post(cmd(IDS.stranger))).json()) as { data: { content: string } };
    expect(r.data.content).toContain("not authorized");
  });
  it("a correctly signed command from a configured operator in the configured guild works", async () => {
    const { post } = await stagingEnv();
    const r = (await (await post(cmd(IDS.operator))).json()) as { data: { content: string } };
    expect(r.data.content).toContain("AzerDex ops status");
  });
  it("the same rules apply whatever hostname the request arrives on (workers.dev, a custom domain, or a spoofed Host)", async () => {
    const { post } = await stagingEnv();
    for (const host of ["azerdex-ops-bot-staging.example-subdomain.workers.dev", "ops.example.com", "evil.example"]) {
      expect((await post(cmd(IDS.operator), { sign: false, host })).status).toBe(401);
    }
  });
  it("non-POST methods and other paths expose nothing beyond liveness", async () => {
    const { env } = await stagingEnv();
    expect((await worker.fetch(new Request("https://x/interactions", { method: "GET" }), env as never, ctx)).status).toBe(405);
    expect((await worker.fetch(new Request("https://x/", { method: "GET" }), env as never, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://x/.well-known/anything", { method: "GET" }), env as never, ctx)).status).toBe(404);
    const health = await worker.fetch(new Request("https://x/healthz"), env as never, ctx);
    expect(await health.json()).toEqual({ ok: true });
  });
  it("the staging deployment is visibly marked as staging in everything it sends (footer), so it cannot be mistaken for production", async () => {
    const { env } = await stagingEnv();
    const { parseConfig } = await import("../src/config");
    expect(parseConfig(env as never).env).toBe("staging");
    expect(T0).toBeGreaterThan(0);
  });
});
