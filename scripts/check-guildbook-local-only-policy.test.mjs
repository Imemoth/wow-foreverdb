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

  // The one reviewed use of the 0018 ingest wrapper and projection (0019 technical installation ingest): existence pre-flight plus the single call
  // that sends every upload through the Guildbook-stripping projection. Anything else touching those two objects must stay rejected.
  const reviewed0019 = `
    do $do$ begin
      if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is null
         or to_regprocedure('private.fdb_public_snapshot(jsonb)') is null then
        raise exception '0019 pre-flight: required dependencies are missing';
      end if;
      if to_regclass('private.guildbook_cloud_sync_guard') is null then raise exception '0019 pre-flight: Guildbook local-only guard 0018 is missing'; end if;
    end $do$;
    create table if not exists private.installation_upload_identities (installation_id text not null);
    create or replace function public.ingest_foreverdb_snapshot_auth(p_snapshot jsonb) returns jsonb language plpgsql security definer as $$
    declare v_result jsonb;
    begin
      v_result := private.foreverdb_ingest_snapshot_impl_v1(private.fdb_public_snapshot(p_snapshot));
      return v_result;
    end $$;
  `;
  const REVIEWED = "0019_technical_installation_ingest.sql";
  const wrapperProjection = (violations) => violations.filter((v) => v.includes("ingest wrapper/projection modification"));

  it("accepts the reviewed technical-installation use of the ingest wrapper and projection (positive)", () => {
    assert.deepEqual(guildbookPolicyViolations([approved, { name: REVIEWED, sql: reviewed0019 }]), []);
  });

  it("accepts it only under the reviewed file name, not under another name or number (negative)", () => {
    for (const name of ["0021_technical_installation_ingest.sql", "0019_other_name.sql", "0019_technical_installation_ingest.sql.bak.sql"]) {
      assert(wrapperProjection(guildbookPolicyViolations([approved, { name, sql: reviewed0019 }])).length > 0, name);
    }
  });

  it("still rejects every other way of touching the wrapper or the projection in the reviewed file (negative)", () => {
    const attempts = {
      "redefining the projection": "create or replace function private.fdb_public_snapshot(p jsonb) returns jsonb language sql as $$ select p $$;",
      "redefining the wrapper": "create or replace function private.foreverdb_ingest_snapshot_impl_v1(p jsonb) returns jsonb language sql as $$ select p $$;",
      "quoted identifiers": 'create or replace function "private"."fdb_public_snapshot"(p jsonb) returns jsonb language sql as $$ select p $$;',
      "altering": "alter function private.fdb_public_snapshot(jsonb) security invoker;",
      "dropping": "drop function private.foreverdb_ingest_snapshot_impl_v1(jsonb);",
      "renaming through dynamic SQL": "do $do$ begin execute 'alter function private.foreverdb_ingest_snapshot_impl_v1(jsonb) rename to x'; end $do$;",
      "re-granting the projection": "grant execute on function private.fdb_public_snapshot(jsonb) to anon;",
      "calling the wrapper without the projection": "select private.foreverdb_ingest_snapshot_impl_v1(p_snapshot);",
      "calling the wrapper with a different projection argument": "select private.foreverdb_ingest_snapshot_impl_v1(private.fdb_public_snapshot(other_snapshot));",
      "calling the projection alone": "select private.fdb_public_snapshot(p_snapshot);",
    };
    for (const [label, extra] of Object.entries(attempts)) {
      const found = wrapperProjection(guildbookPolicyViolations([approved, { name: REVIEWED, sql: `${reviewed0019}\n${extra}` }]));
      assert(found.length > 0, label);
    }
  });

  it("does not let the reviewed forms hide a Guildbook cloud write, table or upload path (negative)", () => {
    const hidden = `${reviewed0019}
      create table private.account_guildbook_members (installation_id text);
      insert into private.account_guildbook_members select * from public.installation_guild_members;
      create or replace function public.fdb_guildbook_upload(p jsonb) returns jsonb language sql as $$ select p $$;`;
    const violations = guildbookPolicyViolations([approved, { name: REVIEWED, sql: hidden }]);
    assert(violations.some((v) => v.includes("account-scoped cloud Guildbook storage")));
    assert(violations.some((v) => v.includes("Guildbook cloud data write")));
    assert(violations.some((v) => v.includes("new Guildbook RPC/function")));
  });

  it("keeps the broad rule for every other migration, including a copy of the reviewed text (negative)", () => {
    assert(wrapperProjection(guildbookPolicyViolations([approved, { name: "0017_collector.sql", sql: "select private.fdb_public_snapshot('{}'::jsonb);" }])).length > 0);
  });

  it("allows the exact historical 0005, 0009, 0012, and 0014 files, but not their content under a new name", () => {
    const historical = current.filter((f) => ["0005_guildbook_v1.sql", "0009_api_security_rate_limits.sql", "0012_account_ownership_claims.sql", "0014_zero_touch_enrollment.sql"].includes(f.name));
    assert.equal(historical.length, 4);
    assert.deepEqual(guildbookPolicyViolations([approved, ...historical]), []);
    assert(guildbookPolicyViolations([approved, { ...historical.find((f) => f.name.startsWith("0012")), name: "0019_history_copy.sql" }]).length > 0);
  });
});
