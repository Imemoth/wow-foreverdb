import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, type Env } from "../src/config";
import { parseToml, type TomlTable } from "./helpers/toml-lite";

/**
 * The official AzerDex Discord server already exists (guild 1561649407584370809). Both environments use it, separated by application, token,
 * channel, operators, Worker, D1 and heartbeat. These tests pin that topology in configuration and documentation.
 */
const GUILD_ID = "1561649407584370809";
const ROOT = new URL("../..", import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const toml = parseToml(read("ops-bot/wrangler.toml"));
const envs = toml.env as { staging: TomlTable; production: TomlTable };
const runbook = read("docs/ops-bot/staging-runbook.md");
const checklist = read("docs/ops-bot/production-release-checklist.md");

const stagingSecrets = (): Env => ({ DISCORD_PUBLIC_KEY: "ab".repeat(32), DISCORD_BOT_TOKEN: "STAGING_TOKEN_CANARY_0123456789abcdef", DISCORD_APPLICATION_ID: "900000000000000001", DISCORD_ALERT_CHANNEL_ID: "900000000000000003", OPERATOR_USER_IDS: "900000000000000004" });

describe("configuration: the existing guild, strict per-environment separation", () => {
  it("both environments allow exactly the existing guild, through a plain (non-secret) var, and the Worker config accepts it", () => {
    for (const [name, e] of Object.entries(envs)) {
      const vars = e.vars as TomlTable;
      expect(vars.DISCORD_GUILD_IDS, name).toBe(GUILD_ID);
      expect(/^\d{17,20}$/.test(vars.DISCORD_GUILD_IDS as string)).toBe(true);
    }
    const cfg = parseConfig({ ...stagingSecrets(), DB: {}, BOT_ENV: "staging", HEALTH_PROVIDER: "mock", DISCORD_GUILD_IDS: GUILD_ID });
    expect([...cfg.discord.guildIds]).toEqual([GUILD_ID]);
  });
  it("everything that must differ per environment stays OUT of the committed file (application id, token, public key, channel, operators, heartbeat)", () => {
    const text = read("ops-bot/wrangler.toml").replace(/^\s*#.*$/gm, "");
    for (const k of ["DISCORD_APPLICATION_ID", "DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY", "DISCORD_ALERT_CHANNEL_ID", "OPERATOR_USER_IDS", "OPERATOR_ROLE_IDS", "HEARTBEAT_PING_URL", "FALLBACK_WEBHOOK_URL", "HEALTH_API_SECRET"]) expect(text, k).not.toContain(k);
  });
  it("the two environments share no deployable resource name (Worker, D1)", () => {
    const d1 = (e: TomlTable) => ((e.d1_databases as TomlTable[])[0]!.database_name as string);
    expect(envs.staging.name).not.toBe(envs.production.name);
    expect(d1(envs.staging)).not.toBe(d1(envs.production));
  });
  it("a missing guild allowlist is still refused (fail closed), so the var cannot be silently dropped", () => {
    expect(() => parseConfig({ ...stagingSecrets(), DB: {}, BOT_ENV: "staging", HEALTH_PROVIDER: "mock" })).toThrow();
  });
});

describe("documentation: existing server, proposed channels, no new server", () => {
  it("the staging runbook and the production checklist name the existing guild id", () => {
    expect(runbook).toContain(GUILD_ID);
    expect(checklist).toContain(GUILD_ID);
  });
  it("staging uses #ops-testing and production uses #ops-alerts; #ops-logs is optional and unused by V1; channels are marked proposed/unconfirmed", () => {
    expect(runbook).toContain("#ops-testing");
    expect(runbook).toContain("#ops-alerts");
    expect(runbook).toContain("#ops-logs");
    expect(runbook).toMatch(/proposed and not yet confirmed/i);
    expect(checklist).toContain("#ops-alerts");
    expect(checklist).toMatch(/proposed and not yet confirmed/i);
  });
  it("neither document asks the owner to create a new Discord server, and both preserve existing channels, roles, onboarding and permissions", () => {
    for (const doc of [runbook, checklist]) {
      expect(doc).not.toMatch(/Staging Discord server \+ private channel/);
      expect(doc).not.toMatch(/create (a|the) (new )?(staging )?discord server/i);
    }
    expect(runbook).toMatch(/Do \*\*not\*\* create or require a new Discord server/);
    expect(runbook).toMatch(/existing channels, roles, onboarding/i);
  });
  it("separate applications, tokens, Workers, D1 databases and heartbeat checks are required for staging and production", () => {
    for (const doc of [runbook, checklist]) {
      expect(doc).toMatch(/separate Discord application/i);
      expect(doc).toMatch(/heartbeat/i);
    }
    expect(runbook).toMatch(/azerdex-ops-bot-staging/);
    expect(checklist).toMatch(/azerdex-ops-bot\b/);
  });
  it("the bot invite requests no permissions and the staging bot is granted access to #ops-testing only (it must not be able to post in #ops-alerts)", () => {
    expect(runbook).toContain("permissions=0");
    expect(runbook).toMatch(/staging bot[^\n]*#ops-testing[^\n]*only/i);
    expect(runbook).toMatch(/cannot (post|see)[^\n]*#ops-alerts/i);
  });
  it("the runbook lists the owner-side steps for the first staging test, with Discord, Cloudflare, heartbeat and authorization gates", () => {
    expect(runbook).toMatch(/Owner-side setup for the first staging test/);
    for (const step of ["OPERATIONS", "Developer Portal", "Interactions Endpoint URL", "wrangler secret put", "authoriz"]) expect(runbook, step).toContain(step);
  });
});
