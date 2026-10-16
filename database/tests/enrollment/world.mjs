// Shared fixtures for the zero-touch enrollment suite (migration 0014). Real PostgreSQL + real GoTrue tables, disposable database only.
// The PostgREST layer is emulated exactly like database/tests/account/harness.mjs (SET LOCAL ROLE authenticated + request.jwt.claims).
import { randomBytes, createHash } from "node:crypto";
import { Fixtures, claimsFor, connect, rpc, snapshot, expectCode } from "../account/harness.mjs";

export { expectCode, snapshot, connect, claimsFor };

/** 32 hex characters, the shape of a real Addon installation id (the migration requires 16..128). */
export const instId = () => randomBytes(16).toString("hex");
export const sha256 = (text) => createHash("sha256").update(text).digest();

export const TICKET_RE = /^fdba1_[A-Za-z0-9_-]{43}$/;
export const SECRET_RE = /^fdbd1_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;

export async function makeWorld({ database } = {}) {
  const admin = await connect(database);
  const client = await connect(database);
  const fx = new Fixtures(admin);
  const world = {
    admin,
    client,
    fx,
    /** A registered, confirmed account with a live web session. */
    async account({ confirmed = true } = {}) {
      const id = await fx.identity({ anonymous: false, confirmed });
      return { ...id, kind: "account", call: (fn, args = []) => rpc(client, id.claims, fn, args) };
    },
    /** A device principal: an anonymous Auth identity with a live session (what a fresh Companion has). */
    async device() {
      const id = await fx.identity({ anonymous: true });
      return { ...id, kind: "device", call: (fn, args = []) => rpc(client, id.claims, fn, args) };
    },
    /** Account issues a ticket; returns the whole reply (ok:true carries the raw ticket exactly once). */
    async issue(account, label) {
      await fx.resetBudgets();
      return account.call("fdb_account_enrollment_ticket_issue", label === undefined ? [] : [label]);
    },
    async ticket(account, label) {
      const out = await world.issue(account, label);
      if (!out.ok) throw new Error(`ticket issue failed: ${JSON.stringify(out)}`);
      return out;
    },
    async enroll(device, ticket, installationId, label = "Test PC") {
      await fx.resetBudgets();
      return device.call("fdb_device_enroll", [ticket, installationId, label]);
    },
    /** Full happy path: ticket + enroll for a new installation. Returns { device, account, installationId, secret, deviceId }. */
    async enrolled(account, { installationId = instId(), device } = {}) {
      const d = device ?? (await world.device());
      const t = await world.ticket(account);
      const out = await world.enroll(d, t.ticket, installationId);
      if (!out.ok) throw new Error(`enroll failed: ${JSON.stringify(out)}`);
      return { device: d, account, installationId, secret: out.device_secret, deviceId: out.device_id, ticket: t };
    },
    async ingest(device, secret, snap) {
      await fx.resetBudgets();
      return device.call("fdb_device_ingest", [secret, snap]);
    },
    async row(sql, params = []) {
      return (await admin.query(sql, params)).rows;
    },
    async device_row(id) {
      return (await admin.query("select * from private.devices where id = $1", [id])).rows[0];
    },
    async ticket_row(id) {
      return (await admin.query("select * from private.enrollment_tickets where id = $1", [id])).rows[0];
    },
    async audit(where = "true", params = []) {
      return (await admin.query(`select event, account_uid, actor_uid, device_id, ticket_id, installation_id, detail from private.device_audit where ${where} order by id`, params)).rows;
    },
    /** Stable fingerprint of everything historical for one installation (all stats + Guildbook tables) and of the installation row. */
    async history(installationId) {
      const q = async (sql) => (await admin.query(sql, [installationId])).rows;
      const parts = {
        item: await q("select md5(coalesce(string_agg((to_jsonb(t) - 'updated_at')::text, '|' order by (to_jsonb(t) - 'updated_at')::text), '')) h, count(*)::int n from public.installation_item_stats t where installation_id = $1"),
        source: await q("select md5(coalesce(string_agg((to_jsonb(t) - 'updated_at')::text, '|' order by (to_jsonb(t) - 'updated_at')::text), '')) h, count(*)::int n from public.installation_source_stats t where installation_id = $1"),
        location: await q("select md5(coalesce(string_agg((to_jsonb(t) - 'updated_at')::text, '|' order by (to_jsonb(t) - 'updated_at')::text), '')) h, count(*)::int n from public.installation_location_stats t where installation_id = $1"),
        guilds: await q("select md5(coalesce(string_agg((to_jsonb(t) - 'updated_at')::text, '|' order by (to_jsonb(t) - 'updated_at')::text), '')) h, count(*)::int n from public.installation_guilds t where installation_id = $1"),
        members: await q("select md5(coalesce(string_agg((to_jsonb(t) - 'updated_at')::text, '|' order by (to_jsonb(t) - 'updated_at')::text), '')) h, count(*)::int n from public.installation_guild_members t where installation_id = $1"),
      };
      return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, `${v[0].n}:${v[0].h}`]));
    },
    async close() {
      await client.end();
      await admin.end();
    },
  };
  return world;
}

/** Every text-ish value of the three private tables, concatenated: used to prove no raw ticket/secret was ever stored. */
export async function dumpPrivateTables(admin) {
  const parts = [];
  for (const t of ["private.enrollment_tickets", "private.devices", "private.device_audit"]) {
    parts.push((await admin.query(`select coalesce(string_agg(x::text, E'\\n'), '') as s from ${t} x`)).rows[0].s);
  }
  return parts.join("\n");
}
