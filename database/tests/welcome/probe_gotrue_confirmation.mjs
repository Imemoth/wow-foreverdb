// Evidence probe (not a gate): which auth.users changes does REAL GoTrue make for each way an e-mail address can become confirmed?
// A temporary trigger logs every UPDATE of auth.users that touches a confirmation-related column, together with the one-time
// tokens that still existed at that moment. Output feeds docs/azerdex-welcome-email/gotrue-confirmation-probe.md.
import { connectSuper, gotrue, uniq, DB, adminToken } from "../account/harness.mjs";
import { startSmtpSink } from "./smtp-sink.mjs";
const sink = await startSmtpSink();

const admin = await connectSuper(DB);
await admin.query(`
  create schema if not exists probe; grant usage on schema probe to public;
  create table if not exists probe.log (n bigserial primary key, scenario text, op text, old_conf timestamptz, new_conf timestamptz,
    old_ctok text, new_ctok text, old_rtok text, new_rtok text, old_email text, new_email text, old_ect text, new_ect text, rsent boolean, invited boolean, ott text, at timestamptz default clock_timestamp());
  create or replace function probe.f() returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
  begin
    insert into probe.log(scenario, op, old_conf, new_conf, old_ctok, new_ctok, old_rtok, new_rtok, old_email, new_email, old_ect, new_ect, rsent, invited, ott)
    values (current_setting('probe.scenario', true), tg_op, case when tg_op='INSERT' then null else old.email_confirmed_at end, new.email_confirmed_at,
      case when tg_op='INSERT' then null else nullif(old.confirmation_token,'') end, nullif(new.confirmation_token,''),
      case when tg_op='INSERT' then null else nullif(old.recovery_token,'') end, nullif(new.recovery_token,''),
      case when tg_op='INSERT' then null else old.email end, new.email,
      case when tg_op='INSERT' then null else nullif(old.email_change_token_new,'') end, nullif(new.email_change_token_new,''), new.recovery_sent_at is not null, new.invited_at is not null,
      (select string_agg(token_type::text, ',') from auth.one_time_tokens where user_id = new.id));
    return new;
  end $$;
  drop trigger if exists probe_t on auth.users;
  create trigger probe_t after insert or update on auth.users for each row execute function probe.f();
`);
const out = [];
async function scenario(name, fn) {
  await admin.query(`select set_config('probe.scenario', $1, false)`, [name]);
  const before = (await admin.query(`select coalesce(max(n),0) n from probe.log`)).rows[0].n;
  let note = "";
  try { note = (await fn()) ?? ""; } catch (e) { note = `ERR ${e.message}`; }
  const rows = (await admin.query(`select op, old_conf is not null as old_confirmed, new_conf is not null as new_confirmed,
    (old_ctok is not null) as old_ctok, (new_ctok is not null) as new_ctok, (old_rtok is not null) as old_rtok, (new_rtok is not null) as new_rtok,
    (old_email is distinct from new_email) as email_changed, (old_ect is not null) as old_ect, (new_ect is not null) as new_ect, rsent, invited, ott
    from probe.log where n > $1 order by n`, [before])).rows;
  out.push({ name, note, rows });
}
const tokenFor = async (email, type) =>
  (await admin.query(`select token_hash from auth.one_time_tokens ot join auth.users u on u.id=ot.user_id where u.email=$1 and ($2::text is null or ot.token_type::text=$2) order by ot.created_at desc limit 1`, [email, type ?? null])).rows[0]?.token_hash;
const pw = "Probe-Passw0rd-7788!";
const signup = async (email) => gotrue("/signup", { body: { email, password: pw } });

await scenario("A signup -> verify(signup)", async () => {
  const e = `${uniq("a")}@example.test`; await signup(e);
  const r = await gotrue("/verify", { body: { type: "signup", token_hash: await tokenFor(e, "confirmation_token") } });
  return `verify status ${r.status}`;
});
await scenario("B unconfirmed signup -> recover -> verify(recovery)", async () => {
  const e = `${uniq("b")}@example.test`; await signup(e);
  const rec = await gotrue("/recover", { body: { email: e } });
  const t = await tokenFor(e, "recovery_token");
  const r = t ? await gotrue("/verify", { body: { type: "recovery", token_hash: t } }) : { status: "no recovery token" };
  return `recover ${rec.status}, token ${t ? "yes" : "no"}, verify ${r.status}`;
});
await scenario("C unconfirmed signup -> /otp magic link -> verify(magiclink)", async () => {
  const e = `${uniq("c")}@example.test`; await signup(e);
  const o = await gotrue("/otp", { body: { email: e, create_user: false } });
  const t = await tokenFor(e, null);
  const r = t ? await gotrue("/verify", { body: { type: "magiclink", token_hash: t } }) : { status: "no token" };
  return `otp ${o.status}, token ${t ? "yes" : "no"}, verify ${r.status}`;
});
await scenario("D confirmed user -> recover -> verify(recovery)", async () => {
  const e = `${uniq("d")}@example.test`; await signup(e);
  await gotrue("/verify", { body: { type: "signup", token_hash: await tokenFor(e, "confirmation_token") } });
  await admin.query(`select set_config('probe.scenario','D2 recovery of confirmed',false)`);
  await gotrue("/recover", { body: { email: e } });
  const r = await gotrue("/verify", { body: { type: "recovery", token_hash: await tokenFor(e, "recovery_token") } });
  return `verify ${r.status}`;
});
await scenario("E signup via OTP email (signup then verify type=email)", async () => {
  const e = `${uniq("e")}@example.test`; await signup(e);
  const t = await tokenFor(e, "confirmation_token");
  const r = await gotrue("/verify", { body: { type: "email", token_hash: t } });
  return `verify(type=email, confirmation token) ${r.status}`;
});
await scenario("F signup confirmation token replayed as type=recovery", async () => {
  const e = `${uniq("f")}@example.test`; await signup(e);
  const t = await tokenFor(e, "confirmation_token");
  const r = await gotrue("/verify", { body: { type: "recovery", token_hash: t } });
  return `verify ${r.status}`;
});
let note_extra = "";
await scenario("G confirmed user -> email change -> verify(email_change)", async () => {
  const e = `${uniq("g")}@example.test`; await signup(e);
  const s = await gotrue("/verify", { body: { type: "signup", token_hash: await tokenFor(e, "confirmation_token") } });
  const tok = s.json?.access_token;
  const ch = await gotrue("/user", { method: "PUT", token: tok, body: { email: `${uniq("g2")}@example.test` } });
  const ne = (await admin.query(`select email_change from auth.users where email=$1`, [e])).rows[0]?.email_change;
  const t = (await admin.query(`select token_hash from auth.one_time_tokens ot join auth.users u on u.id=ot.user_id where u.email=$1 and ot.token_type='email_change_token_new' order by ot.created_at desc limit 1`, [e])).rows[0]?.token_hash;
  const v = t ? await gotrue("/verify", { body: { type: "email_change", token_hash: t } }) : { status: "no token" };
  note_extra = `verify ${v.status} newemail=${ne}`;
  return `change ${ch.status} ${note_extra}`;
});
await scenario("H admin invite", async () => {
  const e = `${uniq("h")}@example.test`;
  const r = await gotrue("/invite", { body: { email: e }, token: adminToken() });
  const t = await tokenFor(e, "confirmation_token");
  const v = t ? await gotrue("/verify", { body: { type: "invite", token_hash: t } }) : { status: "no token" };
  return `invite ${r.status}, verify ${v.status}`;
});
await scenario("I admin sets email_confirm=true on unconfirmed signup", async () => {
  const e = `${uniq("i")}@example.test`; const r0 = await signup(e);
  const id = r0.json?.id ?? r0.json?.user?.id;
  const r = await gotrue(`/admin/users/${id}`, { method: "PUT", token: adminToken(), body: { email_confirm: true } });
  return `admin update ${r.status}`;
});
await scenario("J signup, recover requested, THEN the signup link is used", async () => {
  const e = `${uniq("j")}@example.test`; await signup(e);
  const ct = await tokenFor(e, "confirmation_token");
  await gotrue("/recover", { body: { email: e } });
  const v = await gotrue("/verify", { body: { type: "signup", token_hash: ct } });
  return `verify(signup) after recover request: ${v.status}`;
});
console.log(JSON.stringify(out, null, 1));
await admin.query(`drop trigger if exists probe_t on auth.users; drop schema probe cascade`);
await admin.end();
await sink.close();
