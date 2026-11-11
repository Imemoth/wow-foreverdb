import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { REVIEWED_PROJECTION_USE_SHA256, guildbookPolicyViolations, loadMigrationFiles } from "./check-guildbook-local-only-policy.mjs";

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

  // The reviewed exception is the exact bytes of one named file, pinned by hash. These tests use a short stand-in fixture and a test-only override map; the real
  // 0019 (about 23 KB, on the feature branch) is covered by the pinned-entry test and by running the guard against that branch's migration tree.
  const REVIEWED = "0019_technical_installation_ingest.sql";
  const reviewedFixture = `
    do $do$ begin
      if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is null or to_regprocedure('private.fdb_public_snapshot(jsonb)') is null then
        raise exception '0019 pre-flight: required dependencies are missing';
      end if;
    end $do$;
    create or replace function public.ingest_foreverdb_snapshot_auth(p_snapshot jsonb) returns jsonb language plpgsql security definer as $$
    begin
      return private.foreverdb_ingest_snapshot_impl_v1(private.fdb_public_snapshot(p_snapshot));
    end $$;
  `;
  const sha = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
  const pinned = new Map([[REVIEWED, sha(reviewedFixture)]]);
  const wrapperProjection = (violations) => violations.filter((v) => v.includes("ingest wrapper/projection modification"));
  const check = (name, sql, map = pinned) => guildbookPolicyViolations([approved, { name, sql }], map);

  it("without the pinned entry the same text is rejected: the exception is the only thing that admits it (negative control)", () => {
    assert(wrapperProjection(check(REVIEWED, reviewedFixture, new Map())).length > 0);
  });

  it("accepts the exact reviewed bytes under the reviewed name, and a CRLF copy of them (positive)", () => {
    assert.deepEqual(check(REVIEWED, reviewedFixture), []);
    assert.deepEqual(check(REVIEWED, reviewedFixture.replace(/\n/g, "\r\n")), []);
  });

  it("any other byte, even a comment or one changed character, returns the file to the broad rule (negative)", () => {
    for (const changed of [
      `${reviewedFixture}\n-- harmless comment`,
      `${reviewedFixture} `,
      reviewedFixture.replace("p_snapshot jsonb", "p_snapshot  jsonb"),
      `${reviewedFixture}\ndrop function private.fdb_public_snapshot(jsonb);`,
      `${reviewedFixture}\nselect private.foreverdb_ingest_snapshot_impl_v1(p_snapshot);`,
      `${reviewedFixture}\nselect '--'; drop function private.fdb_public_snapshot(jsonb);`,
    ]) assert(wrapperProjection(check(REVIEWED, changed)).length > 0, changed.slice(-60));
  });

  it("the exception is bound to the file name: the same bytes under any other name are rejected (negative)", () => {
    for (const name of ["0021_technical_installation_ingest.sql", "0019_other_name.sql", "0019_technical_installation_ingest.sql.bak.sql", "0017_collector.sql"]) {
      assert(wrapperProjection(check(name, reviewedFixture)).length > 0, name);
    }
  });

  it("the exception exempts only the wrapper/projection rule: every Guildbook rule still applies to the pinned file (negative)", () => {
    const withWrite = `${reviewedFixture}\ncreate table private.account_guildbook_members (a int);\ninsert into private.account_guildbook_members select * from public.installation_guild_members;`;
    const violations = check(REVIEWED, withWrite, new Map([[REVIEWED, sha(withWrite)]]));
    assert(violations.some((v) => v.includes("account-scoped cloud Guildbook storage")));
    assert(violations.some((v) => v.includes("Guildbook cloud data write")));
    assert.deepEqual(wrapperProjection(violations), []);
  });

  it("the real pinned list stays minimal: exactly one reviewed file, with a well-formed sha256 (guards against quiet additions)", () => {
    assert.deepEqual([...REVIEWED_PROJECTION_USE_SHA256.keys()], [REVIEWED]);
    for (const hash of REVIEWED_PROJECTION_USE_SHA256.values()) assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it("the default guard still rejects an unpinned file that touches the wrapper or projection (negative)", () => {
    assert(wrapperProjection(guildbookPolicyViolations([approved, { name: REVIEWED, sql: reviewedFixture }])).length > 0);
  });
});
