import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { guildbookPolicyViolations, loadMigrationFiles } from "../../../scripts/check-guildbook-local-only-policy.mjs";

const root = resolve(__dirname, "../../..");
const approved = loadMigrationFiles(root).find((f) => f.name === "0018_disable_guildbook_cloud_sync.sql")!;
const old0016Content = `
  create table private.account_guildbook_guilds (installation_id text, guild_key text);
  create table private.account_guildbook_members (installation_id text, member_guid text);
  create or replace function public.fdb_account_guildbook_upload(p_snapshot jsonb) returns jsonb
  language plpgsql as $$ begin
    insert into private.account_guildbook_members
    select * from public.installation_guild_members where installation_id = p_snapshot->>'installationId';
    return '{}'::jsonb;
  end $$;
  grant execute on function public.fdb_account_guildbook_upload(jsonb) to authenticated;
`;

describe("guildbook-local-only-policy", () => {
  it("passes the current migration tree", () => {
    expect(guildbookPolicyViolations(loadMigrationFiles(root))).toEqual([]);
  });

  it("rejects the old 0016 cloud behavior under its original filename", () => {
    const violations = guildbookPolicyViolations([
      approved,
      { name: "0016_account_scoped_guildbook.sql", sql: old0016Content },
    ]);
    expect(violations.join("\n")).toMatch(/0016.*permanently reserved/);
    expect(violations.join("\n")).toMatch(/Guildbook cloud table definition/);
  });

  it("rejects the same 0016 behavior when renamed and split across migrations", () => {
    const violations = guildbookPolicyViolations([
      approved,
      { name: "0019_feature.sql", sql: old0016Content },
      { name: "0020_rpc.sql", sql: "create function public.fdb_account_guildbook_members(text) returns setof text language sql as $$ select 'x' $$; grant execute on function public.fdb_account_guildbook_members(text) to authenticated;" },
    ]);
    expect(violations.length).toBeGreaterThanOrEqual(7);
  });

  it("rejects removing or weakening the approved 0018 implementation", () => {
    const weakened = { ...approved, sql: approved.sql.replace("- 'guilds'", "") };
    expect(guildbookPolicyViolations([weakened]).join("\n")).toContain("approved 0018 protection changed");
    expect(guildbookPolicyViolations([]).join("\n")).toContain("approved 0018 protection migration is missing");
  });

  it("allows harmless documentation references and unrelated 0017 collector SQL", () => {
    expect(guildbookPolicyViolations([
      approved,
      { name: "0017_schedule_collector.sql", sql: "-- Guildbook is permanently local-only.\nselect 1;" },
    ])).toEqual([]);
  });

  it("matches the exact historical 0005 and 0012 cloud definitions only", () => {
    const historical = ["0005_guildbook_v1.sql", "0012_account_ownership_claims.sql"].map((name) => ({
      name,
      sql: readFileSync(resolve(root, "database/migrations", name), "utf8"),
    }));
    expect(guildbookPolicyViolations([approved, ...historical])).toEqual([]);
    expect(guildbookPolicyViolations([approved, { ...historical[1], name: "0019_copied_history.sql" }]).length).toBeGreaterThan(0);
  });
});
