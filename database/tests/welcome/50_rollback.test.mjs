// Kill switch, rollback and re-install rehearsals on a CLONE of the test database (never the live stack's database).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { cloneDatabase, dropDatabase, connectSuper, repoRoot, HOST, PORT } from "../account/harness.mjs";
import { openWorld, setSwitches, registerAndConfirm, resetWelcome } from "./world.mjs";

const CLONE = "fdb_welcome_rollback_clone";
let w;
before(async () => {
  w = await openWorld();
  await resetWelcome(w.sup);
  await setSwitches(w.owner, { enqueue: true, dispatch: true });
  await registerAndConfirm(w.sup); // one real event so the clone carries data
  await w.close(); // cloning terminates every backend of the source database, so no connection of ours may be open
  w = null;
  await cloneDatabase(process.env.FDB_IT_DB ?? "fdb_account_it", CLONE);
});
after(async () => {
  await dropDatabase(CLONE);
  const sup = await connectSuper();
  try { await resetWelcome(sup); } finally { await sup.end(); }
});

// The rollback drops triggers on auth.users, which needs table ownership: on Supabase that is the Auth role, here the superuser.
const psql = (file, vars = {}) => {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", process.env.PGUSER, "-d", CLONE, "-f", path.join(repoRoot, file), ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])];
  const r = spawnSync("psql", args, { env: process.env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.replace(/.*NOTICE.*\n/g, "") };
};
const q = async (sql) => { const c = await connectSuper(CLONE); try { return (await c.query(sql)).rows; } finally { await c.end(); } };

test("RB-1 kill switch turns intake and dispatch OFF and keeps every row", async () => {
  const before = (await q(`select count(*)::int n from private.azerdex_welcome_outbox`))[0].n;
  assert.equal(psql("database/rollback/0015_kill_switch.sql").status, 0);
  assert.deepEqual((await q(`select enqueue_enabled e, dispatch_enabled d from private.azerdex_welcome_config`))[0], { e: false, d: false });
  assert.equal((await q(`select count(*)::int n from private.azerdex_welcome_outbox`))[0].n, before);
  assert.equal(psql("database/rollback/0015_kill_switch_restore.sql").status, 0);
  assert.deepEqual((await q(`select enqueue_enabled e, dispatch_enabled d from private.azerdex_welcome_config`))[0], { e: false, d: true }, "restore re-enables dispatch only; intake stays a deliberate manual step");
});

test("RB-2 rollback removes triggers and functions but KEEPS the tables (duplicate memory); re-applying 0015 afterwards works and reuses them", async () => {
  const r = psql("database/rollback/0015_rollback.sql");
  assert.equal(r.status, 0, r.out);
  assert.equal((await q(`select count(*)::int n from pg_trigger where tgrelid='auth.users'::regclass and tgname like 'azerdex\\_welcome\\_%'`))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from pg_proc where proname like 'azerdex\\_welcome\\_%'`))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from private.azerdex_welcome_outbox`))[0].n, 1);
  const re = psql("database/migrations/0015_azerdex_welcome_outbox.sql");
  assert.equal(re.status, 0, re.out);
  assert.equal((await q(`select count(*)::int n from pg_proc where proname like 'azerdex\\_welcome\\_%'`))[0].n, 12);
  assert.equal((await q(`select count(*)::int n from private.azerdex_welcome_outbox`))[0].n, 1);
});

test("RB-3 rollback with drop_data=1 removes the tables too", async () => {
  const r = psql("database/rollback/0015_rollback.sql", { drop_data: 1 });
  assert.equal(r.status, 0, r.out);
  assert.equal((await q(`select count(*)::int n from pg_class where relname like 'azerdex\\_welcome\\_%'`))[0].n, 0);
  assert.equal(psql("database/migrations/0015_azerdex_welcome_outbox.sql").status, 0, "clean reinstall");
});

test("RB-4 the migration never alters or drops a pre-existing object: only azerdex_welcome_* objects and two auth.users triggers differ", async () => {
  const trg = await q(`select tgname from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal and tgname like 'azerdex\\_welcome\\_%' order by 1`);
  assert.deepEqual(trg.map((t) => t.tgname), ["azerdex_welcome_on_confirm", "azerdex_welcome_on_signup"]);
  const base = JSON.parse((await import("node:fs")).readFileSync(path.join(repoRoot, "database/tests/account/.run/functions_before_0012.json"), "utf8"));
  const now = await q(`select json_agg(json_build_object('sig', p.oid::regprocedure::text, 'owner', pg_get_userbyid(p.proowner), 'acl', coalesce(p.proacl::text, ''), 'config', coalesce(p.proconfig, '{}'::text[]), 'md5', md5(p.prosrc)) order by p.oid::regprocedure::text) j from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace) and p.proname not like 'azerdex\\_welcome\\_%'`);
  const byBase = new Map(base.map((f) => [f.sig, f]));
  const unchanged = now[0].j.filter((f) => byBase.has(f.sig));
  assert.ok(unchanged.length === base.length, "every pre-0012 function still exists");
  for (const f of unchanged) assert.deepEqual(f, byBase.get(f.sig), `${f.sig} changed`);
});
