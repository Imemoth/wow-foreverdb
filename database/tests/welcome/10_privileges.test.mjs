// Authorization model of the private outbox: nothing but the owner and the audited SECURITY DEFINER worker RPCs can touch it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openWorld, resetWelcome, setSwitches, registerAndConfirm, signupAnonymous, asService } from "./world.mjs";

let w;
before(async () => (w = await openWorld()));
after(async () => w?.close());

const TABLES = ["azerdex_welcome_config", "azerdex_welcome_candidates", "azerdex_welcome_outbox", "azerdex_welcome_trigger_failures"];
const API_ROLES = ["anon", "authenticated", "service_role"];

async function asRole(role, sql, params = [], claims = {}) {
  const c = w.owner;
  await c.query("begin");
  try {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, aud: "authenticated", ...claims })]);
    await c.query(`set local role ${role}`);
    return await c.query(sql, params);
  } finally {
    await c.query("rollback");
  }
}

test("PR-1 RLS is enabled AND forced on every private table and none has a policy", async () => {
  for (const t of TABLES) {
    const r = (await w.sup.query(`select relrowsecurity rls, relforcerowsecurity f, (select count(*) from pg_policy p where p.polrelid = c.oid)::int pol from pg_class c where c.oid = $1::regclass`, [`private.${t}`])).rows[0];
    assert.deepEqual(r, { rls: true, f: true, pol: 0 }, t);
  }
});

test("PR-2 no API role, PUBLIC or column grant exists on any private welcome table or sequence", async () => {
  for (const t of TABLES) {
    for (const role of API_ROLES) {
      const r = (await w.sup.query(`select has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') a, has_any_column_privilege($1, $2, 'SELECT,INSERT,UPDATE,REFERENCES') b`, [role, `private.${t}`])).rows[0];
      assert.deepEqual(r, { a: false, b: false }, `${role} on ${t}`);
    }
    const pub = (await w.sup.query(`select (c.relacl::text ~ '(^|[{,])=') as pub from pg_class c where c.oid = $1::regclass`, [`private.${t}`])).rows[0];
    assert.equal(pub.pub, false, `PUBLIC grant on ${t}`);
  }
  for (const role of API_ROLES) {
    assert.equal((await w.sup.query(`select has_sequence_privilege($1, 'private.azerdex_welcome_trigger_failures_id_seq', 'USAGE,SELECT,UPDATE') x`, [role])).rows[0].x, false);
  }
});

test("PR-3 anon, authenticated, an ANONYMOUS-user JWT and even service_role get 'permission denied' reading or writing any table", async () => {
  const anon = await signupAnonymous();
  const anonId = anon.user?.id ?? anon.id;
  const personas = [
    ["anon", { role: "anon" }],
    ["authenticated", { sub: "00000000-0000-0000-0000-000000000001", is_anonymous: false }],
    ["authenticated", { sub: anonId, is_anonymous: true }], // anonymous Companion sessions use the authenticated DB role
    ["service_role", { role: "service_role" }],
  ];
  for (const t of TABLES) {
    for (const [role, claims] of personas) {
      for (const sql of [`select * from private.${t}`, `delete from private.${t}`, `update private.${t} set user_id = user_id`.replace("user_id = user_id", t === "azerdex_welcome_config" ? "singleton = singleton" : "user_id = user_id")]) {
        await assert.rejects(() => asRole(role, sql, [], claims), /permission denied/i, `${role} ${sql}`);
      }
    }
  }
  await assert.rejects(() => asRole("authenticated", `insert into private.azerdex_welcome_outbox(user_id, email_sha256) values (gen_random_uuid(), '\\x${"00".repeat(32)}')`), /permission denied/i);
});

test("PR-4 a registered account cannot enqueue itself, edit its row or read others' through any path", async () => {
  await resetWelcome(w.sup);
  await setSwitches(w.owner, { enqueue: true });
  const { id } = await registerAndConfirm(w.sup);
  await assert.rejects(() => asRole("authenticated", `select count(*) from private.azerdex_welcome_outbox`, [], { sub: id }), /permission denied/i);
  await assert.rejects(() => asRole("authenticated", `update private.azerdex_welcome_outbox set status='sent' where user_id = $1`, [id], { sub: id }), /permission denied/i);
  await assert.rejects(() => asRole("authenticated", `select private.azerdex_welcome_set_switch(true, true)`, [], { sub: id }), /permission denied/i);
  await assert.rejects(() => asRole("authenticated", `select private.azerdex_welcome_reconcile()`, [], { sub: id }), /permission denied/i);
});

test("PR-5 every welcome function is SECURITY DEFINER with a pinned search_path; only the three public RPCs are executable, and only by service_role", async () => {
  const fns = (await w.sup.query(`select p.oid::regprocedure::text sig, n.nspname, p.prosecdef, coalesce(p.proconfig,'{}') cfg,
        has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
        has_function_privilege('public', p.oid, 'EXECUTE') pu, has_function_privilege('service_role', p.oid, 'EXECUTE') s
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname like 'azerdex\\_welcome\\_%'`)).rows;
  assert.equal(fns.length, 12);
  for (const f of fns) {
    assert.equal(f.prosecdef, true, f.sig);
    assert.ok(f.cfg.some((c) => c === "search_path=" || c === 'search_path=""'), `${f.sig} search_path ${f.cfg}`);
    assert.deepEqual([f.a, f.u, f.pu], [false, false, false], `${f.sig} exposed`);
    const isRpc = f.nspname === "public";
    assert.equal(f.s, isRpc, `${f.sig} service_role`);
  }
  assert.equal(fns.filter((f) => f.nspname === "public").length, 3);
});

test("PR-6 the worker RPCs accept no recipient, address or free text input", async () => {
  const rows = (await w.sup.query(`select p.proname, p.proargnames, pg_get_function_arguments(p.oid) args from pg_proc p where p.proname in ('azerdex_welcome_claim','azerdex_welcome_finish','azerdex_welcome_stats')`)).rows;
  const all = rows.flatMap((r) => r.proargnames ?? []);
  // exact allowlist of arguments: an address, template, URL or SQL text cannot be passed in
  assert.deepEqual(all.sort(), ["p_error_code", "p_lease_token", "p_limit", "p_outcome", "p_provider_id", "p_retry_after_seconds", "p_user_id"]);
});

test("PR-7 anon/authenticated cannot call the RPCs; a service-role-looking claim on a non-service session is refused; service_role works", async () => {
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(() => asRole(role, `select public.azerdex_welcome_claim(5)`, [], {}), /permission denied/i, role);
    await assert.rejects(() => asRole(role, `select public.azerdex_welcome_stats()`, [], {}), /permission denied/i, role);
    await assert.rejects(() => asRole(role, `select public.azerdex_welcome_finish(gen_random_uuid(), gen_random_uuid(), 'sent', 'abcdefgh1234', null, null)`, [], {}), /permission denied/i, role);
  }
  // defence in depth: even if EXECUTE were granted by mistake, a JWT whose role is not service_role is refused inside the function.
  await w.sup.query(`grant execute on function public.azerdex_welcome_stats() to authenticated`);
  try {
    await assert.rejects(() => asRole("authenticated", `select public.azerdex_welcome_stats()`, [], { sub: "x" }), /forbidden/);
  } finally {
    await w.sup.query(`revoke execute on function public.azerdex_welcome_stats() from authenticated`);
  }
  const stats = await asService(w.owner, async (c) => (await c.query(`select public.azerdex_welcome_stats() j`)).rows[0].j);
  assert.equal(typeof stats.by_status, "object");
});

test("PR-8 the feature ships OFF: switch defaults are false and no activation timestamp exists", async () => {
  const d = (await w.sup.query(`select a.attname, pg_get_expr(d.adbin, d.adrelid) def from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum
     where d.adrelid='private.azerdex_welcome_config'::regclass and a.attname in ('enqueue_enabled','dispatch_enabled')`)).rows;
  assert.equal(d.length, 2);
  for (const r of d) assert.equal(r.def, "false");
  await resetWelcome(w.sup);
  const c = (await w.sup.query(`select enqueue_enabled, dispatch_enabled, activation_at from private.azerdex_welcome_config`)).rows[0];
  assert.deepEqual(c, { enqueue_enabled: false, dispatch_enabled: false, activation_at: null });
});

test("PR-9 the two auth.users triggers exist, are AFTER row triggers on the intended events, enabled, and call the private functions", async () => {
  const t = (await w.sup.query(`select t.tgname, t.tgenabled, p.oid::regprocedure::text fn, pg_get_triggerdef(t.oid) def from pg_trigger t join pg_proc p on p.oid=t.tgfoid
     where t.tgrelid='auth.users'::regclass and t.tgname like 'azerdex\\_welcome\\_%' order by 1`)).rows;
  assert.equal(t.length, 2);
  assert.ok(t.every((x) => x.tgenabled === "O"));
  assert.match(t[0].def, /AFTER UPDATE OF email_confirmed_at ON auth.users FOR EACH ROW WHEN/);
  assert.match(t[1].def, /AFTER INSERT ON auth.users FOR EACH ROW/);
});
