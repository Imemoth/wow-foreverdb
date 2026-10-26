// Database privilege assertions after 0012 (the migration also asserts most of these itself and aborts if they fail).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fixtures, asUser, connect, expectCode, readJson } from "./harness.mjs";

const admin = await connect();
const fx = new Fixtures(admin);
after(() => admin.end());

const PUBLIC_FUNCTIONS = [
  "public.fdb_account_claim_start(text)",
  "public.fdb_account_claim_redeem(text)",
  "public.fdb_installation_link_status(text)",
  "public.fdb_account_installations()",
  "public.fdb_account_guildbook_guilds(text)",
  "public.fdb_account_guildbook_members(text,text,integer,integer)",
];
const GUARDS = ["private.fdb_caller()", "private.fdb_anonymous_caller()", "private.fdb_registered_caller()"];
const TABLES = ["private.installation_claims", "private.account_installations", "private.account_audit"];

const can = async (role, sql, args = []) => (await admin.query(sql.replace("$ROLE", role), args)).rows[0].v;

describe("function privileges", () => {
  for (const sig of PUBLIC_FUNCTIONS) {
    it(`${sig}: authenticated only (not public, anon, service_role); SECURITY DEFINER; search_path pinned; owner = migration role`, async () => {
      assert.equal(await can("authenticated", "select has_function_privilege('$ROLE', $1, 'execute') v", [sig]), true);
      for (const role of ["public", "anon", "service_role"]) assert.equal(await can(role, "select has_function_privilege('$ROLE', $1, 'execute') v", [sig]), false, role);
      const p = (await admin.query("select prosecdef, provolatile, proconfig, pg_get_userbyid(proowner) o from pg_proc where oid = $1::regprocedure", [sig])).rows[0];
      assert.equal(p.prosecdef, true);
      assert.equal(p.provolatile, "v");
      assert.equal(p.o, "fdb_migrator");
      assert.ok(p.proconfig.includes('search_path=""'));
      assert.ok(p.proconfig.some((c) => c.startsWith("lock_timeout=5s")));
      assert.ok(!p.proconfig.some((c) => c.startsWith("statement_timeout=")), "a function-level statement_timeout is inert in PostgreSQL and is deliberately not set");
    });
  }
  for (const sig of GUARDS) {
    it(`${sig}: callable by nobody but its owner`, async () => {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        assert.equal(await can(role, "select has_function_privilege('$ROLE', $1, 'execute') v", [sig]), false, role);
      }
      const p = (await admin.query("select prosecdef, provolatile, proconfig from pg_proc where oid = $1::regprocedure", [sig])).rows[0];
      assert.equal(p.prosecdef, true);
      assert.equal(p.provolatile, "v", "VOLATILE");
      assert.ok(p.proconfig.includes('search_path=""'));
    });
  }
  it("anon and service_role are denied with 42501 when they try to call an account function", async () => {
    const id = await fx.identity({ anonymous: true });
    for (const role of ["anon", "service_role"]) {
      await expectCode(asUser(admin, id.claims, (q) => q("select public.fdb_installation_link_status('x')"), { role }), "42501");
    }
  });
  it("no overloads and no unexpected account functions exist", async () => {
    const r = await admin.query(`select oid::regprocedure::text s from pg_proc where proname ~ '^fdb_' and pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`);
    assert.deepEqual(r.rows.map((x) => x.s), [
      "fdb_account_claim_redeem(text)",
      "fdb_account_claim_start(text)",
      "fdb_account_guildbook_guilds(text)",
      "fdb_account_guildbook_members(text,text,integer,integer)",
      "fdb_account_installations()",
      "fdb_installation_link_status(text)",
      "private.fdb_anonymous_caller()",
      "private.fdb_caller()",
      "private.fdb_registered_caller()",
    ].sort());
  });
  it("every account function is free of dynamic SQL and of exception handlers (defence beyond the linter)", async () => {
    const r = await admin.query(`select proname, prosrc from pg_proc where proname ~ '^fdb_(account|installation|caller|anonymous|registered)' and pronamespace in ('public'::regnamespace, 'private'::regnamespace)`);
    for (const row of r.rows) {
      assert.ok(!/\bexecute\b/i.test(row.prosrc.replace(/--.*$/gm, "")), `${row.proname}: dynamic SQL`);
      assert.ok(!/\bexception\s+when\b/i.test(row.prosrc), `${row.proname}: exception handler`);
    }
  });
});

describe("table privileges", () => {
  for (const table of TABLES) {
    it(`${table}: RLS enabled, no policy, no privilege for any API role`, async () => {
      const c = (await admin.query("select relrowsecurity from pg_class where oid = $1::regclass", [table])).rows[0];
      assert.equal(c.relrowsecurity, true);
      assert.equal((await admin.query("select count(*)::int n from pg_policies where schemaname = 'private' and tablename = $1", [table.split(".")[1]])).rows[0].n, 0);
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        for (const priv of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
          assert.equal(await can(role, `select has_table_privilege('$ROLE', $1, '${priv}') v`, [table]), false, `${role} ${priv}`);
        }
      }
    });
  }
  it("the audit sequence and the private schema are closed to API roles", async () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.equal(await can(role, "select has_sequence_privilege('$ROLE', 'private.account_audit_id_seq', 'usage') v"), false, role);
    }
    for (const role of ["anon", "authenticated"]) assert.equal(await can(role, "select has_schema_privilege('$ROLE', 'private', 'usage') v"), false, role);
  });
  it("raw installation, statistics and Guildbook tables stay closed (direct table access remains revoked)", async () => {
    for (const t of ["installations", "installation_guilds", "installation_guild_members", "installation_guild_professions", "installation_item_stats", "installation_source_stats", "installation_location_stats"]) {
      for (const role of ["anon", "authenticated"]) assert.equal(await can(role, "select has_table_privilege('$ROLE', $1, 'select') v", [`public.${t}`]), false, `${role} ${t}`);
    }
  });
  it("installations.owner_user_id is the only ownership column, and the schema of existing tables is unchanged", async () => {
    const cols = await admin.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'installations' order by ordinal_position");
    assert.deepEqual(cols.rows.map((c) => c.column_name), ["id", "schema_version", "addon_version", "first_seen_at", "last_seen_at", "snapshot_updated_at", "owner_user_id"]);
  });
});

describe("existing functions are untouched by 0012", () => {
  it("every function that existed before 0012 has the identical owner, ACL, config and prosrc hash", async () => {
    const before = readJson("functions_before_0012.json");
    assert.ok(before.length > 20, "baseline captured");
    const now = (await admin.query(`select p.oid::regprocedure::text sig, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text, '') acl, coalesce(p.proconfig, '{}') config, md5(p.prosrc) md5
                                     from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)`)).rows;
    const bySig = new Map(now.map((r) => [r.sig, r]));
    for (const b of before) {
      const a = bySig.get(b.sig);
      assert.ok(a, `${b.sig} still exists`);
      assert.deepEqual({ owner: a.owner, acl: a.acl, config: a.config, md5: a.md5 }, { owner: b.owner, acl: b.acl, config: b.config, md5: b.md5 }, b.sig);
    }
    // Migration 0015 (AzerDex welcome outbox) is a SEPARATE feature whose own suite (database/tests/welcome) owns these twelve functions. They are
    // excluded by exact signature, not by prefix or count: any other new function, or any change to the 0012 set, still fails this assertion.
    const WELCOME_0015 = new Set([
      "azerdex_welcome_claim(integer)",
      "azerdex_welcome_finish(uuid,uuid,text,text,text,integer)",
      "azerdex_welcome_stats()",
      "private.azerdex_welcome_note_failure(uuid,text,boolean)",
      "private.azerdex_welcome_on_confirm()",
      "private.azerdex_welcome_on_signup()",
      "private.azerdex_welcome_operator_requeue(uuid,boolean)",
      "private.azerdex_welcome_operator_resolve(uuid,boolean,text)",
      "private.azerdex_welcome_prune()",
      "private.azerdex_welcome_reconcile()",
      "private.azerdex_welcome_require_server_role()",
      "private.azerdex_welcome_set_switch(boolean,boolean)",
    ]);
    const added = now.filter((r) => !before.some((b) => b.sig === r.sig) && !WELCOME_0015.has(r.sig)).map((r) => r.sig).sort();
    assert.equal(added.length, 9, `exactly the nine new functions were added: ${added.join(", ")}`);
  });
  it("the ingest implementation still takes the same advisory lock key as the account functions", async () => {
    const impl = (await admin.query("select prosrc from pg_proc where oid = 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure")).rows[0].prosrc;
    assert.match(impl, /pg_advisory_xact_lock\(\s*hashtextextended\(\s*installation,\s*0\s*\)\s*\)/);
    for (const fn of ["fdb_account_claim_start", "fdb_account_claim_redeem"]) {
      const src = (await admin.query("select prosrc from pg_proc where proname = $1", [fn])).rows[0].prosrc;
      assert.match(src, /pg_advisory_xact_lock\(hashtextextended\(\w+, 0\)\)/);
    }
  });
});
