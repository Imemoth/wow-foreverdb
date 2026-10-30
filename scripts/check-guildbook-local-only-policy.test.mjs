import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guildbookPolicyViolations, loadMigrationFiles } from "./check-guildbook-local-only-policy.mjs";

const current = loadMigrationFiles();
const approved = current.find((file) => file.name === "0018_disable_guildbook_cloud_sync.sql");
assert.ok(approved, "approved 0018 protection is present");

const old0016 = `
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
  it("accepts the current migration tree", () => {
    assert.deepEqual(guildbookPolicyViolations(current), []);
  });

  it("rejects reintroduced 0016 content under its old number", () => {
    const violations = guildbookPolicyViolations([approved, { name: "0016_account_scoped_guildbook.sql", sql: old0016 }]);
    assert(violations.some((v) => v.includes("0016 is permanently reserved")));
    assert(violations.some((v) => v.includes("Guildbook cloud table")));
  });

  it("rejects reintroduced 0016 content under another filename", () => {
    const violations = guildbookPolicyViolations([
      approved,
      { name: "0020_new_name.sql", sql: old0016 },
      { name: "0021_another_name.sql", sql: "create function public.fdb_account_guildbook_members(text) returns setof text language sql as $$ select 'x' $$; grant execute on function public.fdb_account_guildbook_members(text) to authenticated;" },
    ]);
    assert(violations.length >= 7);
  });

  it("fails if approved 0018 is removed or weakened", () => {
    assert(guildbookPolicyViolations([]).some((v) => v.includes("0018 protection migration is missing")));
    assert(guildbookPolicyViolations([{ ...approved, sql: approved.sql.replace("- 'guilds'", "") }])
      .some((v) => v.includes("approved 0018 protection changed")));
  });

  it("allows SQL documentation references and unrelated 0017 collector work", () => {
    assert.deepEqual(guildbookPolicyViolations([
      approved,
      { name: "0017_collector.sql", sql: "-- Guildbook is permanently local-only.\nselect 1;" },
    ]), []);
  });

  it("allows the exact historical 0005, 0009, 0012, and 0014 files, but not their content under a new name", () => {
    const historical = current.filter((f) => ["0005_guildbook_v1.sql", "0009_api_security_rate_limits.sql", "0012_account_ownership_claims.sql", "0014_zero_touch_enrollment.sql"].includes(f.name));
    assert.equal(historical.length, 4);
    assert.deepEqual(guildbookPolicyViolations([approved, ...historical]), []);
    assert(guildbookPolicyViolations([approved, { ...historical.find((f) => f.name.startsWith("0012")), name: "0019_history_copy.sql" }]).length > 0);
  });
});
