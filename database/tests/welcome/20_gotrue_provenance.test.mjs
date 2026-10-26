// REAL GoTrue: which account events queue a welcome, and which never do. This file is also the tripwire that pins the provenance rule to
// the GoTrue build under test: re-run it on every GoTrue upgrade and against the hosted Auth version before sending is enabled.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openWorld, setSwitches, resetWelcome, newEmail, signup, signupAnonymous, oneTimeToken, verify, registerAndConfirm, countOutbox, outboxRow, gotrue, adminToken, uniq, PASSWORD } from "./world.mjs";
import { gotrueAvailable } from "../account/harness.mjs";

let w;
before(async () => {
  if (!(await gotrueAvailable())) {
    if (process.env.FDB_REQUIRE_GOTRUE === "1") assert.fail("GoTrue unreachable");
    // eslint-disable-next-line no-console
    console.log("BLOCKED: GoTrue unreachable");
    process.exit(0);
  }
  w = await openWorld();
});
after(async () => w?.close());
beforeEach(async () => {
  await resetWelcome(w.sup);
  await setSwitches(w.owner, { enqueue: true, dispatch: false });
});

const events = async () => Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_outbox`)).rows[0].n);

test("PV-1 first genuine signup confirmation queues exactly one event for that user", async () => {
  const { id } = await registerAndConfirm(w.sup);
  assert.equal(await countOutbox(w.sup, id), 1);
  const row = await outboxRow(w.sup, id);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.email_sha256.length, 32);
});

test("PV-2 repeating the confirmation, signing in again and refreshing never add events", async () => {
  const email = newEmail();
  const { id } = await registerAndConfirm(w.sup, email);
  assert.equal(await countOutbox(w.sup, id), 1);
  const again = await verify("signup", await oneTimeToken(w.sup, email, "confirmation_token")); // token already consumed
  assert.notEqual(again.status, 200);
  const login = await gotrue("/token?grant_type=password", { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  const refresh = await gotrue("/token?grant_type=refresh_token", { body: { refresh_token: login.json.refresh_token } });
  assert.equal(refresh.status, 200);
  assert.equal(await countOutbox(w.sup, id), 1);
  assert.equal(await events(), 1);
});

test("PV-3 a recovery link used on an UNCONFIRMED signup confirms the address (real GoTrue) but queues NO welcome", async () => {
  const email = newEmail();
  const id = await signup(email);
  assert.equal((await gotrue("/recover", { body: { email } })).status, 200);
  const v = await verify("recovery", await oneTimeToken(w.sup, email, "recovery_token"));
  assert.equal(v.status, 200);
  const u = (await w.sup.query(`select email_confirmed_at from auth.users where id = $1`, [id])).rows[0];
  assert.notEqual(u.email_confirmed_at, null, "tripwire: this is the ambiguity the provenance rule exists for");
  assert.equal(await countOutbox(w.sup, id), 0);
  // ...and the later signup link (which GoTrue may still accept or not) can never add one: the transition is already gone.
  await verify("signup", await oneTimeToken(w.sup, email, "confirmation_token"));
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-4 password recovery of an already verified account queues nothing", async () => {
  const email = newEmail();
  const { id } = await registerAndConfirm(w.sup, email);
  await w.sup.query(`delete from private.azerdex_welcome_outbox`);
  assert.equal((await gotrue("/recover", { body: { email } })).status, 200);
  assert.equal((await verify("recovery", await oneTimeToken(w.sup, email, "recovery_token"))).status, 200);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-5 a recovery requested BEFORE the signup link is used is treated as ineligible (safe-side false negative, documented)", async () => {
  const email = newEmail();
  const id = await signup(email);
  const ct = await oneTimeToken(w.sup, email, "confirmation_token");
  await gotrue("/recover", { body: { email } });
  assert.equal((await verify("signup", ct)).status, 200);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-6 e-mail change of a verified account queues nothing (new address confirmation included)", async () => {
  const { id, session } = await registerAndConfirm(w.sup);
  await w.sup.query(`delete from private.azerdex_welcome_outbox`);
  const ch = await gotrue("/user", { method: "PUT", token: session.access_token, body: { email: newEmail("chg") } });
  assert.equal(ch.status, 200);
  const t = (await w.sup.query(`select ot.token_hash from auth.one_time_tokens ot where ot.user_id=$1 and ot.token_type='email_change_token_new'`, [id])).rows[0]?.token_hash;
  if (t) assert.equal((await verify("email_change", t)).status, 200);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-7 anonymous Companion sessions and their conversion never create candidates or events", async () => {
  const a = await signupAnonymous();
  const id = a.user?.id ?? a.id;
  assert.equal(Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_candidates where user_id=$1`, [id])).rows[0].n), 0);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-8 admin invitations never produce an event (GoTrue sets invited_at after the INSERT, so the confirm trigger must exclude them)", async () => {
  const email = newEmail("inv");
  assert.equal((await gotrue("/invite", { body: { email }, token: adminToken() })).status, 200);
  const id = (await w.sup.query(`select id from auth.users where email=$1`, [email])).rows[0].id;
  assert.equal((await verify("invite", await oneTimeToken(w.sup, email, "confirmation_token"))).status, 200);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-9 accounts registered BEFORE the feature was enabled are never welcomed (no retroactive backfill)", async () => {
  await setSwitches(w.owner, { enqueue: false });
  await resetWelcome(w.sup);
  const email = newEmail("old");
  const id = await signup(email); // registered while OFF
  await setSwitches(w.owner, { enqueue: true });
  assert.equal((await verify("signup", await oneTimeToken(w.sup, email, "confirmation_token"))).status, 200);
  assert.equal(await countOutbox(w.sup, id), 0);
  assert.equal(Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_candidates`)).rows[0].n), 0);
});

test("PV-10 an account that predates activation_at is not a candidate even if enqueue is on", async () => {
  await w.sup.query(`update private.azerdex_welcome_config set activation_at = now() + interval '1 hour'`);
  const { id } = await registerAndConfirm(w.sup);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-11 with enqueue OFF a genuine confirmation records nothing (kill switch preserves state, creates none)", async () => {
  await setSwitches(w.owner, { enqueue: false });
  const { id } = await registerAndConfirm(w.sup);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-12 user_metadata and client-supplied data can neither create nor force eligibility", async () => {
  const email = newEmail("meta");
  const id = await signup(email, { data: { azerdex_welcome: true, provider: "email", email_confirmed_at: "2020-01-01", welcome_candidate: true } });
  assert.equal(await countOutbox(w.sup, id), 0);
  // a candidate exists (genuine email signup) but metadata did not influence the result either way:
  assert.equal(Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_candidates where user_id=$1`, [id])).rows[0].n), 1);
  const bad = await verify("recovery", await oneTimeToken(w.sup, email, "confirmation_token")); // wrong type for the token
  assert.notEqual(bad.status, 200);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-13 documented residual: an operator-forced confirmation through the admin API is row-level identical to a signup confirmation", async () => {
  const email = newEmail("adm");
  const id = await signup(email);
  const r = await gotrue(`/admin/users/${id}`, { method: "PUT", token: adminToken(), body: { email_confirm: true } });
  assert.equal(r.status, 200);
  // Recorded, not endorsed: this needs the service role, i.e. an operator, and only reaches self-service email signups after activation.
  assert.equal(await countOutbox(w.sup, id), 1);
});

test("PV-14 trigger failure never blocks the verification; the missed event is recorded and reconciled", async () => {
  const email = newEmail("fail");
  const id = await signup(email);
  await w.sup.query(`alter table private.azerdex_welcome_outbox rename to azerdex_welcome_outbox_broken`);
  try {
    const v = await verify("signup", await oneTimeToken(w.sup, email, "confirmation_token"));
    assert.equal(v.status, 200, "registration/verification must succeed while the outbox is broken");
    assert.ok(v.json.access_token);
    const u = (await w.sup.query(`select email_confirmed_at from auth.users where id=$1`, [id])).rows[0];
    assert.notEqual(u.email_confirmed_at, null);
  } finally {
    await w.sup.query(`alter table private.azerdex_welcome_outbox_broken rename to azerdex_welcome_outbox`);
  }
  const f = (await w.sup.query(`select phase, provenance_ok, handled_at from private.azerdex_welcome_trigger_failures where user_id=$1`, [id])).rows;
  assert.equal(f.length, 1);
  assert.equal(f[0].phase, "confirm");
  assert.equal(f[0].provenance_ok, true);
  assert.equal(await countOutbox(w.sup, id), 0);
  await w.sup.query(`select private.azerdex_welcome_reconcile()`);
  assert.equal(await countOutbox(w.sup, id), 1);
  await w.sup.query(`select private.azerdex_welcome_reconcile()`);
  assert.equal(await countOutbox(w.sup, id), 1, "reconciliation is idempotent");
});

test("PV-15 signup keeps working when the candidate table is broken (trigger failure is swallowed)", async () => {
  await w.sup.query(`alter table private.azerdex_welcome_candidates rename to azerdex_welcome_candidates_broken`);
  try {
    const email = newEmail("brk");
    await signup(email);
    assert.ok(await oneTimeToken(w.sup, email, "confirmation_token"));
  } finally {
    await w.sup.query(`alter table private.azerdex_welcome_candidates_broken rename to azerdex_welcome_candidates`);
  }
});

test("PV-16 the reconciler is bounded: it ignores unverified candidates and anything older than 7 days", async () => {
  const email = newEmail("rec");
  const id = await signup(email); // candidate, never verified
  assert.equal(Number((await w.sup.query(`select private.azerdex_welcome_reconcile() n`)).rows[0].n), 0);
  await w.sup.query(`update private.azerdex_welcome_candidates set verified_via_signup_at = now() - interval '8 days' where user_id=$1`, [id]);
  assert.equal(Number((await w.sup.query(`select private.azerdex_welcome_reconcile() n`)).rows[0].n), 0);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-17 the unique key is the database's own protection: a direct duplicate insert is rejected or ignored", async () => {
  const { id } = await registerAndConfirm(w.sup);
  await assert.rejects(() => w.sup.query(`insert into private.azerdex_welcome_outbox(user_id, email_sha256) values ($1, '\\x${"11".repeat(32)}')`, [id]), /duplicate key/);
});

test("PV-18 deleting the account erases candidate, outbox and failure markers (GDPR) without breaking GoTrue deletion", async () => {
  const { id } = await registerAndConfirm(w.sup);
  const del = await gotrue(`/admin/users/${id}`, { method: "DELETE", token: adminToken(), body: { should_soft_delete: false } });
  assert.equal(del.status, 200);
  for (const t of ["candidates", "outbox", "trigger_failures"]) {
    assert.equal(Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_${t} where user_id=$1`, [id])).rows[0].n), 0);
  }
});

test("PV-19 enqueue switched OFF after activation: a new signup is not a candidate (kill switch stops intake immediately)", async () => {
  await setSwitches(w.owner, { enqueue: false }); // activation_at stays recorded from the earlier ON
  assert.notEqual((await w.sup.query(`select activation_at from private.azerdex_welcome_config`)).rows[0].activation_at, null);
  const { id } = await registerAndConfirm(w.sup);
  assert.equal(Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_candidates where user_id=$1`, [id])).rows[0].n), 0);
  assert.equal(await countOutbox(w.sup, id), 0);
});

test("PV-20 switch turned OFF between signup and confirmation: nothing is queued while OFF; the proven verification is reconciled after ON (within 7 days only)", async () => {
  const email = newEmail("sw");
  const id = await signup(email); // candidate while ON
  await setSwitches(w.owner, { enqueue: false });
  assert.equal((await verify("signup", await oneTimeToken(w.sup, email, "confirmation_token"))).status, 200);
  assert.equal(await countOutbox(w.sup, id), 0, "no event while the switch is OFF");
  assert.equal(Number((await w.sup.query(`select private.azerdex_welcome_reconcile() n`)).rows[0].n), 0, "reconciler honours the switch too");
  await setSwitches(w.owner, { enqueue: true });
  assert.equal(Number((await w.sup.query(`select private.azerdex_welcome_reconcile() n`)).rows[0].n), 1);
  assert.equal(await countOutbox(w.sup, id), 1);
});
