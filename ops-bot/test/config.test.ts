import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, parseHeartbeatUrl, type Env } from "../src/config";
import { IDS } from "./helpers/fakes";

const TOKEN = "CANARY_BOT_TOKEN_0123456789abcdefghijk";
const SECRET = "CANARY_HEALTH_SECRET_0123456789abcdefghijk";
const HB = "https://hc.example/ping/CANARY-HEARTBEAT-UUID";
const FB = "https://fb.example/CANARY-FALLBACK-TOKEN";
const staging = (): Env => ({ DB: {}, BOT_ENV: "staging", DISCORD_PUBLIC_KEY: "ab".repeat(32), DISCORD_BOT_TOKEN: TOKEN, DISCORD_APPLICATION_ID: IDS.app, DISCORD_ALERT_CHANNEL_ID: IDS.channel, DISCORD_GUILD_IDS: IDS.guild, OPERATOR_USER_IDS: IDS.operator, HEALTH_PROVIDER: "mock" });
const production = (): Env => ({ ...staging(), BOT_ENV: "production", HEALTH_PROVIDER: "http", HEALTH_API_URL: "https://reports.example/ops-health", HEALTH_API_SECRET: SECRET, HEARTBEAT_PING_URL: HB, FALLBACK_WEBHOOK_URL: FB });
const issues = (env: Env): string[] => { try { parseConfig(env); return []; } catch (e) { expect(e).toBeInstanceOf(ConfigError); return [...(e as ConfigError).issues]; } };

describe("configuration (fail closed)", () => {
  it("parses a valid staging and a valid production configuration", () => {
    expect(parseConfig(staging()).env).toBe("staging");
    const p = parseConfig(production());
    expect(p.env).toBe("production"); expect(p.health.kind).toBe("http"); expect(p.discord.apiBase).toBe("https://discord.com/api/v10");
  });
  it.each(["DB", "BOT_ENV", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_ALERT_CHANNEL_ID", "DISCORD_GUILD_IDS", "HEALTH_PROVIDER"] as const)("secret/setting absence: missing %s is refused", (k) => {
    const env = staging(); delete env[k];
    expect(issues(env).some((i) => i.startsWith(k) || (k === "HEALTH_PROVIDER" && i.startsWith("HEALTH_PROVIDER")))).toBe(true);
  });
  it("invalid values are refused: bad public key, short token, non-snowflake ids, too many guilds, unknown environment", () => {
    expect(issues({ ...staging(), DISCORD_PUBLIC_KEY: "nothex" })).toContain("DISCORD_PUBLIC_KEY:invalid");
    expect(issues({ ...staging(), DISCORD_BOT_TOKEN: "short" })).toContain("DISCORD_BOT_TOKEN:invalid");
    expect(issues({ ...staging(), DISCORD_ALERT_CHANNEL_ID: "12ab" })).toContain("DISCORD_ALERT_CHANNEL_ID:invalid");
    expect(issues({ ...staging(), DISCORD_GUILD_IDS: Array.from({ length: 6 }, (_, i) => `90000000000000010${i}`).join(",") })).toContain("DISCORD_GUILD_IDS:invalid");
    expect(issues({ ...staging(), BOT_ENV: "prod" })).toContain("BOT_ENV:invalid");
  });
  it("no authorized operator configured: refused (nobody is authorized by default)", () => {
    const env = staging(); delete env.OPERATOR_USER_IDS;
    expect(issues(env)).toContain("OPERATORS:none_configured");
    expect(issues({ ...staging(), OPERATOR_USER_IDS: "abc" })).toContain("OPERATOR_USER_IDS:invalid");
  });
  it("production guards: no mock provider, heartbeat and fallback are mandatory, no Discord API redirection", () => {
    expect(issues({ ...production(), HEALTH_PROVIDER: "mock" })).toContain("HEALTH_PROVIDER:mock_not_allowed_in_production");
    const noHb = production(); delete noHb.HEARTBEAT_PING_URL; expect(issues(noHb)).toContain("HEARTBEAT_PING_URL:required_in_production");
    const noFb = production(); delete noFb.FALLBACK_WEBHOOK_URL; expect(issues(noFb)).toContain("FALLBACK_WEBHOOK_URL:required_in_production");
    expect(issues({ ...production(), DISCORD_API_BASE: "https://mock.example/api" })).toContain("DISCORD_API_BASE:not_allowed");
  });
  it("the http health provider requires an https URL and a long secret; non-https URLs are refused everywhere", () => {
    expect(issues({ ...production(), HEALTH_API_URL: "http://reports.example/x" })).toContain("HEALTH_API_URL:invalid");
    expect(issues({ ...production(), HEALTH_API_SECRET: "short" })).toContain("HEALTH_API_SECRET:invalid");
    expect(issues({ ...production(), HEARTBEAT_PING_URL: "http://hc.example/x" })).toContain("HEARTBEAT_PING_URL:invalid");
    expect(issues({ ...staging(), FALLBACK_WEBHOOK_URL: "ftp://x" })).toContain("FALLBACK_WEBHOOK_URL:invalid");
    expect(issues({ ...staging(), HEARTBEAT_PING_URL: "https://user:pass@hc.example/x" })).toContain("HEARTBEAT_PING_URL:invalid");
  });
  it("staging may point the Discord API at a mock (https only)", () => {
    expect(parseConfig({ ...staging(), DISCORD_API_BASE: "https://mock.example/api/" }).discord.apiBase).toBe("https://mock.example/api");
    expect(issues({ ...staging(), DISCORD_API_BASE: "http://mock.example" })).toContain("DISCORD_API_BASE:not_allowed");
  });
  it("a ConfigError never contains any secret or URL value (safe to log)", () => {
    const bad: Env = { ...production(), DISCORD_PUBLIC_KEY: "bad", HEALTH_API_URL: "http://x", DISCORD_GUILD_IDS: "nope", HEARTBEAT_PING_URL: "http://hc.example/CANARY-HEARTBEAT-UUID" };
    let msg = ""; try { parseConfig(bad); } catch (e) { msg = (e as Error).message + JSON.stringify((e as ConfigError).issues); }
    expect(msg.length).toBeGreaterThan(0);
    for (const canary of [TOKEN, SECRET, "CANARY-HEARTBEAT-UUID", "CANARY-FALLBACK-TOKEN", "reports.example"]) expect(msg).not.toContain(canary);
  });
  it("the heartbeat URL is parsed independently so a misconfigured worker can still signal failure", () => {
    expect(parseHeartbeatUrl({ HEARTBEAT_PING_URL: HB })).toBe(HB);
    expect(parseHeartbeatUrl({ HEARTBEAT_PING_URL: "http://nope" })).toBeNull();
    expect(parseHeartbeatUrl({})).toBeNull();
  });
});
