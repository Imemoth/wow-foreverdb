import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseToml, type TomlTable } from "./helpers/toml-lite";

/**
 * Wrangler routing and environment validation (see the comment block in wrangler.toml for the verified Cloudflare rules).
 * Static checks only: they prove the repository configuration; a real deployment still needs the staging runbook.
 */
const ROOT = new URL("../..", import.meta.url).pathname;       // repository root
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const toml = parseToml(read("ops-bot/wrangler.toml"));
const env = toml.env as { staging: TomlTable; production: TomlTable };
const staging = env.staging;
const production = env.production;
const WORKERS_DEV_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;       // <= 63 chars, alphanumeric and dashes, no leading/trailing dash

describe("wrangler.toml: nothing is exposed by default", () => {
  it("the top level does not publish anything: no workers.dev, no preview URLs, no routes, no cron, no bindings", () => {
    expect(toml.workers_dev).toBe(false);       // Cloudflare defaults workers_dev to TRUE when no route is configured; it must be explicit
    expect(toml.preview_urls).toBe(false);
    for (const k of ["route", "routes", "triggers", "d1_databases", "vars"]) expect(toml, k).not.toHaveProperty(k);
  });
  it("exactly two named environments exist, so a typo'd or missing --env cannot silently reuse another environment's settings", () => {
    expect(Object.keys(env).sort()).toEqual(["production", "staging"]);
  });
});

describe("staging routing: public HTTPS endpoint on workers.dev (Discord must reach it)", () => {
  it("workers.dev is enabled explicitly, with no route or custom domain", () => {
    expect(staging.workers_dev).toBe(true);
    for (const k of ["route", "routes"]) expect(staging, k).not.toHaveProperty(k);   // a route would make Cloudflare infer workers_dev=false
  });
  it("preview/version URLs stay disabled (Wrangler >= 4.44 would otherwise follow workers_dev and add a second public hostname)", () => {
    expect(staging.preview_urls).toBe(false);
  });
  it("the Worker name yields a valid workers.dev label and is distinct from production", () => {
    const name = staging.name as string;
    expect(name).toBe("azerdex-ops-bot-staging");
    expect(WORKERS_DEV_LABEL.test(name)).toBe(true);
    expect(name).not.toBe(production.name);
    expect(name).not.toMatch(/secret|token|password|key|private/i);   // workers.dev hostnames are public certificate-transparency records
  });
  it("has its own D1 database, the 5-minute cron, and the staging-only mock provider", () => {
    expect((staging.triggers as TomlTable).crons).toEqual(["*/5 * * * *"]);
    const d1 = (staging.d1_databases as TomlTable[])[0]!;
    expect(d1.database_name).toBe("azerdex-ops-bot-staging");
    expect(d1.database_id).toBe("REPLACE_WITH_STAGING_D1_ID");
    expect(staging.vars).toEqual({ BOT_ENV: "staging", HEALTH_PROVIDER: "mock" });
  });
});

describe("production routing: documented, NOT activated", () => {
  it("workers.dev and preview URLs are disabled; production is reachable only through a Custom Domain", () => {
    expect(production.workers_dev).toBe(false);
    expect(production.preview_urls).toBe(false);
    const routes = production.routes as TomlTable[];
    expect(routes).toHaveLength(1);
    expect(routes[0]!.custom_domain).toBe(true);
  });
  it("the hostname is an RFC 2606 .invalid placeholder with no wildcard, so `wrangler deploy --env production` cannot succeed until a reviewed PR replaces it", () => {
    const pattern = (production.routes as TomlTable[])[0]!.pattern as string;
    expect(pattern).toMatch(/^REPLACE-WITH-PRODUCTION-OPS-HOSTNAME\.invalid$/);
    expect(pattern).not.toContain("*");
    expect(pattern).not.toContain("/");
  });
  it("has separate worker name, D1 placeholder, and http (never mock) health provider", () => {
    expect(production.name).toBe("azerdex-ops-bot");
    expect((production.d1_databases as TomlTable[])[0]!.database_id).toBe("REPLACE_WITH_PRODUCTION_D1_ID");
    expect(production.vars).toEqual({ BOT_ENV: "production", HEALTH_PROVIDER: "http" });
    expect((production.triggers as TomlTable).crons).toEqual(["*/5 * * * *"]);
  });
  it("no real account id, zone id, database id, hostname or secret is committed in either environment", () => {
    const text = read("ops-bot/wrangler.toml");
    expect(text).not.toMatch(/\b[0-9a-f]{32}\b/);                           // Cloudflare account/zone ids
    expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/); // D1 database ids (UUIDs)
    expect(text).not.toMatch(/account_id|zone_id|zone_name/);
    expect(text).not.toMatch(/\.workers\.dev["'\s]*$/m);                   // no concrete workers.dev hostname is hard-coded
  });
});

describe("documentation matches the configuration", () => {
  const runbook = read("docs/ops-bot/staging-runbook.md");
  const checklist = read("docs/ops-bot/production-release-checklist.md");
  it("the staging runbook gives the workers.dev interactions URL, the account-subdomain prerequisite, and the no-Cloudflare-Access rule", () => {
    expect(runbook).toContain("azerdex-ops-bot-staging.<account-subdomain>.workers.dev/interactions");
    expect(runbook).toMatch(/`workers\.dev` account subdomain/);
    expect(runbook).toMatch(/Cloudflare Access/);
    expect(runbook).toMatch(/preview_urls = false/);
  });
  it("the production checklist requires a Custom Domain on an owner zone, replaces the placeholder via a reviewed PR, and forbids Access on the endpoint", () => {
    expect(checklist).toContain("custom_domain");
    expect(checklist).toContain("REPLACE-WITH-PRODUCTION-OPS-HOSTNAME.invalid");
    expect(checklist).toMatch(/Cloudflare Access/);
  });
});
