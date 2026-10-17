// Browser pairing fixtures use only the disposable Account/GoTrue integration stack.
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { makeWorld as enrollmentWorld } from "../enrollment/world.mjs";
import { DB, repoRoot, connect, cloneDatabase, dropDatabase, psqlFile } from "../account/harness.mjs";
export { connect, dropDatabase, psqlFile, randomUUID };
export const migration = path.join(repoRoot, "database/migrations/0016_browser_pairing.sql");
export const makeWorld = enrollmentWorld;
export const roles = ["public", "anon", "authenticated", "service_role"];
export const events = ["pairing_started", "pairing_approved", "pairing_denied", "pairing_expired", "pairing_connected", "pairing_revoked", "pairing_retry_deferred"];

// A clone is restored to the 0014 schema so order/preservation proofs work before AND after apply16.
export async function before16(fn) {
  const database = `fdb_pairing_schema_${randomBytes(6).toString("hex")}`;
  await cloneDatabase(DB, database);
  const admin = await connect(database);
  try {
    await admin.query(`alter table private.devices drop column if exists pairing_id cascade;
      alter table private.devices alter column ticket_id set not null;
      drop table if exists private.device_pairing_audit, private.device_pairings, private.device_pairing_config cascade`);
    return await fn({ database, admin });
  } finally {
    await admin.end();
    await dropDatabase(database);
  }
}

export async function functions(admin) {
  return (await admin.query(`select p.oid::regprocedure::text sig,
    md5(pg_get_functiondef(p.oid)) definition, pg_get_userbyid(p.proowner) owner,
    coalesce(p.proacl::text, '') acl from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`)).rows;
}

export async function protectedState(admin) {
  const tables = ["private.account_installations", "private.account_audit"];
  const state = { functions: await functions(admin) };
  for (const table of tables) {
    state[table] = (await admin.query(`select c.relrowsecurity, c.relforcerowsecurity, c.relacl::text,
      (select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) columns,
      (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid) constraints,
      (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname=split_part($1,'.',1) and tablename=split_part($1,'.',2)) indexes
      from pg_class c where c.oid=$1::regclass`, [table])).rows;
  }
  for (const table of ["public.installations", "private.account_installations", "private.account_audit", "private.installation_claims", "private.enrollment_tickets", "private.devices", "private.device_audit",
    "public.installation_item_stats", "public.installation_source_stats", "public.installation_location_stats", "public.installation_guilds", "public.installation_guild_members", "public.installation_guild_professions", "public.items", "public.sources"]) {
    // Adding nullable provenance must leave every historical device field unchanged.
    state[`${table}:rows`] = (await admin.query(`select count(*)::int n,
      md5(coalesce(string_agg((to_jsonb(t) - 'pairing_id')::text, '|' order by (to_jsonb(t) - 'pairing_id')::text), '')) hash from ${table} t`)).rows;
  }
  return state;
}

export async function pending(admin, overrides = {}) {
  const values = {
    id: randomUUID(), installation_id: randomBytes(16).toString("hex"), initiator_uid: randomUUID(), initiator_session_id: randomUUID(),
    poll_secret_hash: randomBytes(32), proposed_device_id: randomUUID(), device_credential_hash: randomBytes(32),
    status: "pending", created_at: new Date(), expires_at: new Date(Date.now() + 299000), next_poll_at: new Date(Date.now() + 5000), ...overrides,
  };
  const keys = Object.keys(values);
  return (await admin.query(`insert into private.device_pairings (${keys.join(",")}) values (${keys.map((_,i)=>`$${i+1}`).join(",")}) returning *`, Object.values(values))).rows[0];
}

export async function rollback(admin, fn) {
  await admin.query("begin");
  try { return await fn(); } finally { await admin.query("rollback"); }
}
