import { z } from "zod";

/** Raw Worker environment: bindings, plain variables and SECRETS (secrets only via `wrangler secret put`, never in files). */
export interface Env {
  DB?: unknown;
  BOT_ENV?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_ALERT_CHANNEL_ID?: string;
  DISCORD_GUILD_IDS?: string;
  OPERATOR_USER_IDS?: string;
  OPERATOR_ROLE_IDS?: string;
  DISCORD_API_BASE?: string;
  HEALTH_PROVIDER?: string;
  HEALTH_API_URL?: string;
  HEALTH_API_SECRET?: string;
  EXPECTED_SOURCE_KEYS?: string;
  HEARTBEAT_PING_URL?: string;
  FALLBACK_WEBHOOK_URL?: string;
}

export interface Tuning {
  snapshotMaxAgeSeconds: number;
  snapshotFutureSkewSeconds: number;
  g6ExpectedIntervalMinutes: number;
  g6StaleAfterMinutes: number;
  providerFailureThreshold: number;
  authFailureThreshold: number;
  recoveryConfirmations: number;
  reminderIntervalMinutes: number;
  maxReminders: number;
  cronGapMinutes: number;
  outboxMaxAttempts: number;
  outboxBatch: number;
  maintenanceMaxMinutes: number;
  rateLimitPerMinute: number;
  retentionResolvedDays: number;
  interactionDeadlineMs: number;
  interactionTimestampSkewSeconds: number;
  maxBodyBytes: number;
}

export const DEFAULT_TUNING: Tuning = {
  snapshotMaxAgeSeconds: 600,        // reporting endpoint must return a snapshot generated within 10 minutes
  snapshotFutureSkewSeconds: 120,
  g6ExpectedIntervalMinutes: 15,
  g6StaleAfterMinutes: 45,           // three missed */15 executions
  providerFailureThreshold: 3,       // consecutive failed 5-minute polls before 'reporting unavailable' becomes CRITICAL
  authFailureThreshold: 2,           // 401/403 are configuration faults: escalate sooner
  recoveryConfirmations: 2,          // consecutive healthy polls before an incident is RESOLVED
  reminderIntervalMinutes: 120,
  maxReminders: 1,
  cronGapMinutes: 20,                // four missed 5-minute cycles
  outboxMaxAttempts: 8,
  outboxBatch: 10,
  maintenanceMaxMinutes: 1440,
  rateLimitPerMinute: 10,
  retentionResolvedDays: 90,
  interactionDeadlineMs: 2500,       // Discord requires an initial response within 3 s
  interactionTimestampSkewSeconds: 300,
  maxBodyBytes: 65536,
};

export interface Config {
  env: "staging" | "production";
  discord: { publicKey: string; botToken: string; applicationId: string; alertChannelId: string; guildIds: ReadonlySet<string>; apiBase: string };
  operators: { userIds: ReadonlySet<string>; roleIds: ReadonlySet<string> };
  health: { kind: "http"; url: string; secret: string } | { kind: "mock" };
  expectedSourceKeys: readonly string[];
  heartbeatUrl: string | null;
  fallbackUrl: string | null;
  tuning: Tuning;
}

export class ConfigError extends Error {
  /** Issue codes only. Values are never included: a ConfigError can be logged safely. */
  constructor(public readonly issues: readonly string[]) { super(`invalid configuration: ${issues.join(", ")}`); }
}

const snowflake = /^\d{17,20}$/;
const csv = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const httpsUrl = (v: string) => { try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash; } catch { return false; } };

export const DISCORD_API_DEFAULT = "https://discord.com/api/v10";
const DEFAULT_EXPECTED_SOURCES = ["blizzard-bluepost-us", "blizzard-bluepost-eu", "blizzard-news-us"];

/** Heartbeat URL is parsed on its own so a misconfigured worker can still signal failure to the external monitor. */
export function parseHeartbeatUrl(env: Env): string | null {
  const v = env.HEARTBEAT_PING_URL?.trim();
  return v && httpsUrl(v) ? v : null;
}

export function parseConfig(env: Env): Config {
  const issues: string[] = [];
  const need = (name: keyof Env, ok: boolean) => { if (!ok) issues.push(`${String(name)}:${env[name] === undefined || env[name] === "" ? "missing" : "invalid"}`); };

  const botEnv = env.BOT_ENV;
  need("BOT_ENV", botEnv === "staging" || botEnv === "production");
  need("DB", env.DB !== undefined && env.DB !== null);
  need("DISCORD_PUBLIC_KEY", /^[0-9a-fA-F]{64}$/.test(env.DISCORD_PUBLIC_KEY ?? ""));
  need("DISCORD_BOT_TOKEN", (env.DISCORD_BOT_TOKEN ?? "").length >= 20 && !/\s/.test(env.DISCORD_BOT_TOKEN ?? ""));
  need("DISCORD_APPLICATION_ID", snowflake.test(env.DISCORD_APPLICATION_ID ?? ""));
  need("DISCORD_ALERT_CHANNEL_ID", snowflake.test(env.DISCORD_ALERT_CHANNEL_ID ?? ""));

  const guildIds = csv(env.DISCORD_GUILD_IDS);
  need("DISCORD_GUILD_IDS", guildIds.length >= 1 && guildIds.length <= 5 && guildIds.every((g) => snowflake.test(g)));
  const userIds = csv(env.OPERATOR_USER_IDS);
  const roleIds = csv(env.OPERATOR_ROLE_IDS);
  if (!userIds.every((u) => snowflake.test(u))) issues.push("OPERATOR_USER_IDS:invalid");
  if (!roleIds.every((r) => snowflake.test(r))) issues.push("OPERATOR_ROLE_IDS:invalid");
  if (userIds.length + roleIds.length === 0) issues.push("OPERATORS:none_configured"); // fail closed: nobody is authorized

  // The Discord API base can be redirected ONLY outside production, and only to https.
  let apiBase = DISCORD_API_DEFAULT;
  if (env.DISCORD_API_BASE) {
    if (botEnv === "production" || !httpsUrl(env.DISCORD_API_BASE)) issues.push("DISCORD_API_BASE:not_allowed");
    else apiBase = env.DISCORD_API_BASE.replace(/\/$/, "");
  }

  let health: Config["health"] = { kind: "mock" };
  const provider = env.HEALTH_PROVIDER;
  if (provider === "http") {
    need("HEALTH_API_URL", httpsUrl(env.HEALTH_API_URL ?? ""));
    need("HEALTH_API_SECRET", (env.HEALTH_API_SECRET ?? "").length >= 32);
    health = { kind: "http", url: env.HEALTH_API_URL ?? "", secret: env.HEALTH_API_SECRET ?? "" };
  } else if (provider === "mock") {
    if (botEnv === "production") issues.push("HEALTH_PROVIDER:mock_not_allowed_in_production");
  } else issues.push("HEALTH_PROVIDER:missing_or_invalid");

  const hb = env.HEARTBEAT_PING_URL?.trim();
  if (hb && !httpsUrl(hb)) issues.push("HEARTBEAT_PING_URL:invalid");
  if (botEnv === "production" && !hb) issues.push("HEARTBEAT_PING_URL:required_in_production");
  const fb = env.FALLBACK_WEBHOOK_URL?.trim();
  if (fb && !httpsUrl(fb)) issues.push("FALLBACK_WEBHOOK_URL:invalid");
  if (botEnv === "production" && !fb) issues.push("FALLBACK_WEBHOOK_URL:required_in_production");

  const expected = csv(env.EXPECTED_SOURCE_KEYS);
  const expectedKeys = expected.length ? expected : DEFAULT_EXPECTED_SOURCES;
  if (!expectedKeys.every((k) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(k))) issues.push("EXPECTED_SOURCE_KEYS:invalid");

  if (issues.length) throw new ConfigError(issues);
  return {
    env: botEnv as "staging" | "production",
    discord: { publicKey: env.DISCORD_PUBLIC_KEY!.toLowerCase(), botToken: env.DISCORD_BOT_TOKEN!, applicationId: env.DISCORD_APPLICATION_ID!, alertChannelId: env.DISCORD_ALERT_CHANNEL_ID!, guildIds: new Set(guildIds), apiBase },
    operators: { userIds: new Set(userIds), roleIds: new Set(roleIds) },
    health, expectedSourceKeys: expectedKeys, heartbeatUrl: hb ?? null, fallbackUrl: fb ?? null,
    tuning: { ...DEFAULT_TUNING },
  };
}

export const envSchemaVersion = z.literal(1); // reserved: configuration schema version
