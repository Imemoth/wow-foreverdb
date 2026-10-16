// Shared helpers for the welcome-outbox suites (real PostgreSQL + real GoTrue + in-process SMTP sink; disposable only).
import { randomUUID } from "node:crypto";
import { connect, connectSuper, gotrue, adminToken, uniq, DB, sleep } from "../account/harness.mjs";
import { startSmtpSink } from "./smtp-sink.mjs";

export { connect, connectSuper, gotrue, adminToken, uniq, DB, sleep };
export const PASSWORD = "Welcome-Passw0rd-7788!";

export async function openWorld() {
  const sink = await startSmtpSink();
  const owner = await connect(); // fdb_migrator: stand-in for Supabase `postgres`
  const sup = await connectSuper();
  return {
    sink,
    owner,
    sup,
    async close() {
      await sink.close();
      await owner.end();
      await sup.end();
    },
  };
}

/** Switch positions as the owner would set them (private.azerdex_welcome_set_switch). */
export async function setSwitches(owner, { enqueue, dispatch }) {
  await owner.query(`select private.azerdex_welcome_set_switch($1, $2)`, [enqueue ?? null, dispatch ?? null]);
}
/** Back to the shipped state: both OFF, activation cleared, all welcome rows removed (test isolation only). */
export async function resetWelcome(sup) {
  await sup.query(`delete from private.azerdex_welcome_trigger_failures; delete from private.azerdex_welcome_outbox; delete from private.azerdex_welcome_candidates;
    update private.azerdex_welcome_config set enqueue_enabled=false, dispatch_enabled=false, activation_at=null`);
}

export const newEmail = (p = "w") => `${uniq(p)}@example.test`;

export async function signup(email, extra = {}) {
  const r = await gotrue("/signup", { body: { email, password: PASSWORD, ...extra } });
  if (r.status !== 200) throw new Error(`signup failed ${r.status}`);
  return r.json?.id ?? r.json?.user?.id;
}
export async function signupAnonymous() {
  const r = await gotrue("/signup", { body: {} });
  if (r.status !== 200) throw new Error(`anonymous signup failed ${r.status}`);
  return r.json;
}

export async function oneTimeToken(sup, email, type = null) {
  return (
    await sup.query(
      `select ot.token_hash from auth.one_time_tokens ot join auth.users u on u.id = ot.user_id
        where u.email = $1 and ($2::text is null or ot.token_type::text = $2) order by ot.created_at desc limit 1`,
      [email, type],
    )
  ).rows[0]?.token_hash;
}

export const verify = (type, token_hash) => gotrue("/verify", { body: { type, token_hash } });

/** A real signup followed by the real confirmation link: the genuine first verification. */
export async function registerAndConfirm(sup, email = newEmail()) {
  const id = await signup(email);
  const v = await verify("signup", await oneTimeToken(sup, email, "confirmation_token"));
  if (v.status !== 200) throw new Error(`confirm failed ${v.status}`);
  return { id, email, session: v.json };
}

export async function outboxRow(sup, id) {
  return (await sup.query(`select * from private.azerdex_welcome_outbox where user_id = $1`, [id])).rows[0] ?? null;
}
export async function countOutbox(sup, id) {
  return Number((await sup.query(`select count(*) n from private.azerdex_welcome_outbox where user_id = $1`, [id])).rows[0].n);
}

/** Call the worker RPCs as the PostgREST service role would (claims carry role=service_role). */
export async function asService(client, fn, { role = "service_role" } = {}) {
  await client.query("begin");
  try {
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, aud: "authenticated" })]);
    await client.query(`set local role ${role === "service_role" ? "service_role" : role}`);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}
export const claim = (client, limit = 10) => asService(client, async (c) => (await c.query(`select public.azerdex_welcome_claim($1) as j`, [limit])).rows[0].j);
export const finish = (client, a) =>
  asService(client, async (c) =>
    (
      await c.query(`select public.azerdex_welcome_finish($1,$2,$3,$4,$5,$6) as ok`, [a.user_id, a.lease_token, a.outcome, a.provider_id ?? null, a.error_code ?? null, a.retry_after_seconds ?? null])
    ).rows[0].ok,
  );
export { randomUUID };
