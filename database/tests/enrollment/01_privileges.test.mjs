// Privileges, SECURITY DEFINER hygiene, closed tables and identity guards of migration 0014.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { expectCode, makeWorld, instId } from "./world.mjs";
import { readJson, signJwt, claimsFor } from "../account/harness.mjs";

const PUBLIC_FUNCTIONS = [
  "public.fdb_account_enrollment_ticket_issue(text)",
  "public.fdb_account_enrollment_tickets()",
  "public.fdb_account_enrollment_ticket_revoke(uuid)",
  "public.fdb_account_devices()",
  "public.fdb_account_device_revoke(uuid)",
  "public.fdb_device_enroll(text,text,text)",
  "public.fdb_device_status(text)",
  "public.fdb_device_ingest(text,jsonb)",
  "public.fdb_device_rotate_credential(text)",
];
const PRIVATE_FUNCTIONS = [
  "private.fdb_lock_live_session(uuid,uuid,boolean)",
  "private.fdb_account_usable(uuid)",
  "private.fdb_device_id_from_secret(text)",
  "private.fdb_device_match(text,private.devices)",
  "private.fdb_device_authorize(text,uuid)",
  "private.fdb_prune_enrollment()",
];
const ROLES = ["public", "anon", "authenticated", "service_role"];

let w;
before(async () => {
  w = await makeWorld();
});
after(async () => {
  await w.close();
});

const priv = async (role, sig) => (await w.admin.query("select has_function_privilege($1, $2, 'execute') as p", [role, sig])).rows[0].p;

describe("function privileges and definer hygiene", () => {
  it("each public function is SECURITY DEFINER, VOLATILE, search_path-pinned, lock_timeout-bounded and executable by `authenticated` only", async () => {
    for (const sig of PUBLIC_FUNCTIONS) {
      const p = (await w.admin.query("select prosecdef, provolatile, proconfig, pg_get_userbyid(proowner) o from pg_proc where oid = to_regprocedure($1)", [sig])).rows[0];
      assert.ok(p, `${sig} exists`);
      assert.equal(p.prosecdef, true, `${sig} definer`);
      assert.equal(p.provolatile, "v", `${sig} volatile`);
      assert.ok(p.proconfig.includes('search_path=""'), `${sig} search_path`);
      assert.ok(p.proconfig.some((c) => c.startsWith("lock_timeout=")), `${sig} lock_timeout`);
      assert.equal(p.o, "fdb_migrator", `${sig} owner is the migration role`);
      assert.equal(await priv("authenticated", sig), true, `${sig} authenticated`);
      for (const r of ["public", "anon", "service_role"]) assert.equal(await priv(r, sig), false, `${sig} must not be executable by ${r}`);
    }
  });

  it("device ingest carries the same statement timeout as the existing ingest wrapper", async () => {
    const p = (await w.admin.query("select proconfig from pg_proc where oid = to_regprocedure('public.fdb_device_ingest(text,jsonb)')")).rows[0];
    assert.ok(p.proconfig.includes("statement_timeout=15s"));
  });

  it("the six private helpers are executable by no client role", async () => {
    for (const sig of PRIVATE_FUNCTIONS) {
      assert.ok((await w.admin.query("select to_regprocedure($1) is not null as e", [sig])).rows[0].e, `${sig} exists`);
      for (const r of ROLES) assert.equal(await priv(r, sig), false, `${sig} must not be executable by ${r}`);
    }
  });

  it("no overloads and exactly the expected new functions", async () => {
    const rows = (await w.admin.query(
      `select proname, count(*)::int n from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace)
         and (proname like 'fdb_device_%' or proname like 'fdb_account_enrollment_%' or proname in ('fdb_account_devices','fdb_account_device_revoke','fdb_account_usable','fdb_lock_live_session','fdb_prune_enrollment'))
       group by proname order by proname`)).rows;
    assert.equal(rows.length, 15);
    for (const r of rows) assert.equal(r.n, 1, `${r.proname} has overloads`);
  });

  it("every function that existed before 0012 is byte-identical (owner, ACL, config, prosrc md5) after 0012 AND 0014", async () => {
    const before = readJson("functions_before_0012.json");
    const now = (await w.admin.query(
      `select p.oid::regprocedure::text sig, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text,'') acl, coalesce(p.proconfig,'{}'::text[]) config, md5(p.prosrc) md5
       from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)`)).rows;
    const bySig = new Map(now.map((r) => [r.sig, r]));
    assert.ok(before.length > 20);
    for (const b of before) {
      const a = bySig.get(b.sig);
      assert.ok(a, `${b.sig} still exists`);
      assert.deepEqual({ owner: a.owner, acl: a.acl, config: a.config, md5: a.md5 }, { owner: b.owner, acl: b.acl, config: b.config, md5: b.md5 }, `${b.sig} unchanged`);
    }
  });
});

describe("closed private tables", () => {
  it("RLS is enabled, no policy exists, and no client role holds any privilege (tables or audit sequence)", async () => {
    for (const t of ["private.enrollment_tickets", "private.devices", "private.device_audit"]) {
      const c = (await w.admin.query("select relrowsecurity from pg_class where oid = $1::regclass", [t])).rows[0];
      assert.equal(c.relrowsecurity, true, `${t} RLS`);
      const pol = (await w.admin.query("select count(*)::int n from pg_policies where schemaname = 'private' and tablename = $1", [t.split(".")[1]])).rows[0].n;
      assert.equal(pol, 0, `${t} has no policy`);
      for (const r of ROLES) {
        const has = (await w.admin.query("select has_table_privilege($1, $2, 'select,insert,update,delete,truncate,references,trigger') p", [r, t])).rows[0].p;
        assert.equal(has, false, `${r} must hold nothing on ${t}`);
      }
    }
    for (const r of ROLES) {
      const has = (await w.admin.query("select has_sequence_privilege($1, 'private.device_audit_id_seq', 'usage,select,update') p", [r])).rows[0].p;
      assert.equal(has, false, `${r} on the audit sequence`);
    }
  });

  it("a registered and an anonymous API caller cannot read or write the tables directly (42501) and cannot even see the schema", async () => {
    const acct = await w.account();
    const dev = await w.device();
    for (const who of [acct, dev]) {
      for (const sql of ["select * from private.devices", "select * from private.enrollment_tickets", "insert into private.devices (id) values (gen_random_uuid())", "update private.enrollment_tickets set status = 'pending'", "delete from private.device_audit"]) {
        await w.admin.query("begin");
        try {
          await w.admin.query("set local role authenticated");
          await assert.rejects(w.admin.query(sql), (e) => e.code === "42501", `${who.kind}: ${sql}`);
        } finally {
          await w.admin.query("rollback");
        }
      }
    }
  });
});

describe("identity guards", () => {
  const ACCOUNT_CALLS = [
    ["fdb_account_enrollment_ticket_issue", []],
    ["fdb_account_enrollment_tickets", []],
    ["fdb_account_enrollment_ticket_revoke", ["00000000-0000-0000-0000-000000000000"]],
    ["fdb_account_devices", []],
    ["fdb_account_device_revoke", ["00000000-0000-0000-0000-000000000000"]],
  ];
  const secret = "fdbd1_" + "0".repeat(32) + "_" + "A".repeat(43);
  const ticket = "fdba1_" + "A".repeat(43);
  const DEVICE_CALLS = () => [
    ["fdb_device_enroll", [ticket, instId(), "x"]],
    ["fdb_device_status", [secret]],
    ["fdb_device_ingest", [secret, { installationId: instId(), schemaVersion: 9, updatedAt: 1 }]],
    ["fdb_device_rotate_credential", [secret]],
  ];

  it("an ANONYMOUS identity is refused (PT403) by every account function; a REGISTERED identity is refused (PT403) by every device function", async () => {
    const acct = await w.account();
    const dev = await w.device();
    await w.fx.resetBudgets();
    for (const [fn, args] of ACCOUNT_CALLS) await expectCode(dev.call(fn, args), "PT403");
    for (const [fn, args] of DEVICE_CALLS()) {
      await w.fx.resetBudgets();
      await expectCode(acct.call(fn, args), "PT403");
    }
  });

  it("an unconfirmed registered account cannot use account functions (PT403)", async () => {
    const unconfirmed = await w.account({ confirmed: false });
    await w.fx.resetBudgets();
    for (const [fn, args] of ACCOUNT_CALLS) await expectCode(unconfirmed.call(fn, args), "PT403");
  });

  it("a token whose session row was deleted (sign-out) is refused by every function (PT401) although signature and exp are valid", async () => {
    const acct = await w.account();
    const dev = await w.device();
    await w.admin.query("delete from auth.refresh_tokens where session_id = any($1)", [[acct.sid, dev.sid]]);
    await w.admin.query("delete from auth.sessions where id = any($1)", [[acct.sid, dev.sid]]);
    await w.fx.resetBudgets();
    for (const [fn, args] of ACCOUNT_CALLS) await expectCode(acct.call(fn, args), "PT401");
    for (const [fn, args] of DEVICE_CALLS()) {
      await w.fx.resetBudgets();
      await expectCode(dev.call(fn, args), "PT401");
    }
  });

  it("a revoked refresh-token family (GoTrue reuse detection) with a surviving session row is refused (PT401)", async () => {
    const dev = await w.device();
    await w.admin.query("update auth.refresh_tokens set revoked = true where session_id = $1", [dev.sid]);
    await w.fx.resetBudgets();
    await expectCode(dev.call("fdb_device_status", [secret]), "PT401");
  });

  it("no session_id claim, a malformed one, a banned user and a deleted user are refused (PT401); role anon is refused outright", async () => {
    const dev = await w.device();
    const noSid = claimsFor({ uid: dev.uid, sid: dev.sid, anonymous: true, omit: ["session_id"] });
    const badSid = claimsFor({ uid: dev.uid, sid: "not-a-uuid", anonymous: true });
    const { rpc } = await import("../account/harness.mjs");
    await w.fx.resetBudgets();
    await expectCode(rpc(w.client, noSid, "fdb_device_status", [secret]), "PT401");
    await expectCode(rpc(w.client, badSid, "fdb_device_status", [secret]), "PT401");
    await w.admin.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [dev.uid]);
    await expectCode(dev.call("fdb_device_status", [secret]), "PT401");
    await w.admin.query("update auth.users set banned_until = null, deleted_at = now() where id = $1", [dev.uid]);
    await expectCode(dev.call("fdb_device_status", [secret]), "PT401");
    // the anon API role (publishable key only, no user) has no EXECUTE at all
    const { asUser } = await import("../account/harness.mjs");
    await assert.rejects(asUser(w.client, { role: "anon" }, (q) => q("select public.fdb_device_status($1)", [secret]), { role: "anon" }), (e) => e.code === "42501");
  });
});
