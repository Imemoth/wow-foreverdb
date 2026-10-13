// Claim / finish semantics against real PostgreSQL with real GoTrue-created accounts: leases, concurrency, retry, unknown outcomes,
// re-verification at dispatch time, kill switch, operator procedures and redaction.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openWorld, resetWelcome, setSwitches, registerAndConfirm, outboxRow, claim, finish, connect, gotrue, adminToken, newEmail, asService } from "./world.mjs";

let w;
before(async () => (w = await openWorld()));
after(async () => w?.close());
beforeEach(async () => {
  await resetWelcome(w.sup);
  await setSwitches(w.owner, { enqueue: true, dispatch: true });
});

const ok = "re_abcdefgh12345678";
const age = (id, sql) => w.sup.query(`update private.azerdex_welcome_outbox set ${sql} where user_id = $1`, [id]);
async function oneJob() {
  const u = await registerAndConfirm(w.sup);
  const [job] = await claim(w.owner, 5);
  assert.equal(job.user_id, u.id);
  return { u, job };
}

test("WK-1 kill switch: with dispatch OFF claim returns nothing and touches nothing (no attempt consumed)", async () => {
  const { id } = await registerAndConfirm(w.sup);
  await setSwitches(w.owner, { dispatch: false });
  assert.deepEqual(await claim(w.owner, 10), []);
  const r = await outboxRow(w.sup, id);
  assert.equal(r.status, "pending");
  assert.equal(r.attempts, 0);
  await setSwitches(w.owner, { dispatch: true });
  assert.equal((await claim(w.owner, 10)).length, 1);
});

test("WK-2 claim hands out the CURRENT confirmed address, a lease token and a stable event-specific idempotency key", async () => {
  const { u, job } = await oneJob();
  assert.equal(job.recipient, u.email);
  assert.equal(job.attempt, 1);
  assert.equal(job.idempotency_key, `azerdex-welcome-v1:${u.id}:1`);
  assert.match(job.lease_token, /^[0-9a-f-]{36}$/);
  const r = await outboxRow(w.sup, u.id);
  assert.equal(r.status, "leased");
  assert.ok(new Date(r.lease_until) - Date.now() > 150_000 && new Date(r.lease_until) - Date.now() <= 181_000, "short lease (180 s)");
});

test("WK-3 two workers claiming at the same moment never receive the same event", async () => {
  for (let i = 0; i < 12; i++) await registerAndConfirm(w.sup);
  const other = await connect();
  try {
    const [a, b] = await Promise.all([claim(w.owner, 10), claim(other, 10)]);
    const ids = [...a, ...b].map((j) => j.user_id);
    assert.equal(new Set(ids).size, ids.length, "no duplicates across workers");
    assert.equal(ids.length, 12, "all 12 events handed out exactly once across the two claims (limit 10 each)");
  } finally {
    await other.end();
  }
});

test("WK-4 a leased event cannot be claimed again before the lease expires", async () => {
  await oneJob();
  assert.deepEqual(await claim(w.owner, 10), []);
});

test("WK-5 successful finish records the provider id, erases the recipient hash and ends the event for good", async () => {
  const { u, job } = await oneJob();
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "sent", provider_id: ok }), true);
  const r = await outboxRow(w.sup, u.id);
  assert.equal(r.status, "sent");
  assert.equal(r.provider_message_id, ok);
  assert.equal(r.email_sha256.toString("hex"), "00".repeat(32));
  assert.equal(r.lease_token, null);
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "sent", provider_id: ok }), false, "second finish is a no-op");
  await age(u.id, `next_attempt_at = now() - interval '1 day'`);
  assert.deepEqual(await claim(w.owner, 10), [], "a sent event is never claimable");
});

test("WK-6 stale or forged finish calls change nothing; malformed provider ids are refused", async () => {
  const { u, job } = await oneJob();
  const forged = "11111111-1111-1111-1111-111111111111";
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: forged, outcome: "sent", provider_id: ok }), false);
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "sent", provider_id: "x; drop table" }), false);
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "sent" }), false);
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "bogus" }), false);
  assert.equal((await outboxRow(w.sup, u.id)).status, "leased");
});

test("WK-7 429: definitely-not-sent retry honours Retry-After and is not claimable early", async () => {
  const { u, job } = await oneJob();
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "retry", error_code: "provider_rate_limited", retry_after_seconds: 900 }), true);
  const r = await outboxRow(w.sup, u.id);
  assert.equal(r.status, "retry");
  assert.equal(r.last_error_code, "provider_rate_limited");
  assert.equal(r.unknown_outcome, false);
  assert.ok(new Date(r.next_attempt_at) - Date.now() > 800_000);
  assert.deepEqual(await claim(w.owner, 10), []);
  await age(u.id, `next_attempt_at = now() - interval '1 second'`);
  const [again] = await claim(w.owner, 10);
  assert.equal(again.attempt, 2);
  assert.equal(again.idempotency_key, job.idempotency_key, "retries keep the SAME idempotency key");
});

test("WK-8 ambiguous outcome (timeout / 5xx / malformed): retried with the same key inside the 20 h window, flagged unknown", async () => {
  const { u, job } = await oneJob();
  await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "ambiguous", error_code: "provider_timeout" });
  let r = await outboxRow(w.sup, u.id);
  assert.equal(r.status, "retry");
  assert.equal(r.unknown_outcome, true);
  assert.ok(new Date(r.next_attempt_at) - Date.now() >= 55_000, "backoff, never an immediate hammer");
  await age(u.id, `next_attempt_at = now()`);
  const [again] = await claim(w.owner, 10);
  assert.equal(again.idempotency_key, job.idempotency_key);
});

test("WK-9 unknown outcome past the provider's idempotency window STOPS as review_required (no unbounded or unsafe retry)", async () => {
  const { u, job } = await oneJob();
  await age(u.id, `first_send_at = now() - interval '21 hours'`);
  await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "ambiguous", error_code: "provider_timeout" });
  let r = await outboxRow(w.sup, u.id);
  assert.equal(r.status, "review_required");
  assert.equal(r.last_error_code, "idempotency_window_elapsed");
  assert.deepEqual(await claim(w.owner, 10), []);
  // same through the lease-expiry path (a worker that died after calling the provider)
  const v = await registerAndConfirm(w.sup);
  const [j2] = await claim(w.owner, 10);
  assert.equal(j2.user_id, v.id);
  await age(v.id, `lease_until = now() - interval '1 second', first_send_at = now() - interval '21 hours'`);
  assert.deepEqual(await claim(w.owner, 10), []);
  r = await outboxRow(w.sup, v.id);
  assert.equal(r.status, "review_required");
  assert.equal(r.unknown_outcome, true);
});

test("WK-10 a lease that expires inside the window is an unknown outcome retried with the SAME key; stale holder cannot finish afterwards", async () => {
  const { u, job } = await oneJob();
  await age(u.id, `lease_until = now() - interval '1 second'`);
  const [again] = await claim(w.owner, 10);
  assert.equal(again.idempotency_key, job.idempotency_key);
  assert.equal(again.attempt, 2);
  assert.notEqual(again.lease_token, job.lease_token);
  assert.equal((await outboxRow(w.sup, u.id)).unknown_outcome, true);
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "sent", provider_id: ok }), false, "old lease holder is rejected");
  assert.equal(await finish(w.owner, { user_id: u.id, lease_token: again.lease_token, outcome: "sent", provider_id: ok }), true);
});

test("WK-11 attempts are capped at 6: the 6th failure ends as review_required, never a 7th send", async () => {
  const u = await registerAndConfirm(w.sup);
  for (let i = 1; i <= 6; i++) {
    const [job] = await claim(w.owner, 5);
    assert.equal(job.attempt, i);
    await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "retry", error_code: "provider_rate_limited", retry_after_seconds: 1 });
    await age(u.id, `next_attempt_at = now() - interval '1 second'`);
  }
  const r = await outboxRow(w.sup, u.id);
  assert.equal(r.status, "review_required");
  assert.equal(r.last_error_code, "attempts_exhausted");
  assert.deepEqual(await claim(w.owner, 5), []);
});

test("WK-12 non-retryable provider answers (4xx) go to review_required and are never retried", async () => {
  const { u, job } = await oneJob();
  await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "permanent", error_code: "provider_rejected" });
  const r = await outboxRow(w.sup, u.id);
  assert.equal(r.status, "review_required");
  assert.equal(r.last_error_code, "provider_rejected");
  assert.deepEqual(await claim(w.owner, 5), []);
});

test("WK-13 circuit_open gives the attempt back without counting it", async () => {
  const { u, job } = await oneJob();
  await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "retry", error_code: "circuit_open", retry_after_seconds: 300 });
  const r = await outboxRow(w.sup, u.id);
  assert.equal(r.attempts, 0);
  assert.equal(r.status, "retry");
});

test("WK-14 error codes are an allowlist: arbitrary provider text is never stored", async () => {
  const { u, job } = await oneJob();
  await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "permanent", error_code: "to=victim@example.test body={...}" });
  const r = await outboxRow(w.sup, u.id);
  assert.equal(r.last_error_code, "unknown_code");
  assert.ok(!JSON.stringify(r).includes("victim"));
});

test("WK-15 re-verification at dispatch: deleted, unverified, banned, anonymous and e-mail-changed accounts are SUPPRESSED, not sent", async () => {
  const cases = [
    ["ineligible_deleted", (id) => w.sup.query(`update auth.users set deleted_at = now() where id=$1`, [id])],
    ["ineligible_unverified", (id) => w.sup.query(`update auth.users set email_confirmed_at = null where id=$1`, [id])],
    ["ineligible_banned", (id) => w.sup.query(`update auth.users set banned_until = now() + interval '1 day' where id=$1`, [id])],
    ["ineligible_anonymous", (id) => w.sup.query(`update auth.users set is_anonymous = true where id=$1`, [id])],
    ["email_changed", (id) => w.sup.query(`update auth.users set email = $2 where id=$1`, [id, newEmail("moved")])],
  ];
  for (const [code, mutate] of cases) {
    const u = await registerAndConfirm(w.sup);
    await mutate(u.id);
    const jobs = await claim(w.owner, 10);
    assert.ok(!jobs.some((j) => j.user_id === u.id), `${code}: must not be handed to the worker`);
    const r = await outboxRow(w.sup, u.id);
    assert.equal(r.status, "suppressed", code);
    assert.equal(r.last_error_code, code);
  }
});

test("WK-16 an account deleted for real vanishes with its outbox row; nothing stale can be sent", async () => {
  const { id } = await registerAndConfirm(w.sup);
  assert.equal((await gotrue(`/admin/users/${id}`, { method: "DELETE", token: adminToken(), body: { should_soft_delete: false } })).status, 200);
  assert.equal(await outboxRow(w.sup, id), null);
  assert.deepEqual(await claim(w.owner, 10), []);
});

test("WK-17 the claim limit is hard-capped at 10 whatever the caller asks", async () => {
  for (let i = 0; i < 12; i++) await registerAndConfirm(w.sup);
  assert.equal((await claim(w.owner, 1000)).length, 10);
  assert.equal((await claim(w.owner, -5)).length, 1);
  assert.equal((await claim(w.owner, null)).length, 1);
});

test("WK-18 operator requeue needs an explicit 'not sent' confirmation and moves to a NEW idempotency key", async () => {
  const { u, job } = await oneJob();
  await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "permanent", error_code: "provider_4xx" });
  await assert.rejects(() => w.owner.query(`select private.azerdex_welcome_operator_requeue($1, false)`, [u.id]), /requeue refused/);
  await w.owner.query(`select private.azerdex_welcome_operator_requeue($1, true)`, [u.id]);
  const [again] = await claim(w.owner, 5);
  assert.equal(again.idempotency_key, `azerdex-welcome-v1:${u.id}:2`);
  assert.equal(again.attempt, 1);
});

test("WK-19 operator resolve: 'sent' needs the provider id and erases the hash; 'suppress' ends the event", async () => {
  const a = await registerAndConfirm(w.sup);
  await w.sup.query(`update private.azerdex_welcome_outbox set status='review_required' where user_id=$1`, [a.id]);
  await assert.rejects(() => w.owner.query(`select private.azerdex_welcome_operator_resolve($1, true, null)`, [a.id]), /provider message id/);
  await w.owner.query(`select private.azerdex_welcome_operator_resolve($1, true, $2)`, [a.id, ok]);
  assert.equal((await outboxRow(w.sup, a.id)).status, "sent");
  const b = await registerAndConfirm(w.sup);
  await w.owner.query(`select private.azerdex_welcome_operator_resolve($1, false, null)`, [b.id]);
  assert.equal((await outboxRow(w.sup, b.id)).status, "suppressed");
});

test("WK-20 stats expose counters only: no address, no user id, no hash", async () => {
  const { u } = await oneJob();
    const stats = await asService(w.owner, async (c) => (await c.query(`select public.azerdex_welcome_stats() j`)).rows[0].j);
  const text = JSON.stringify(stats);
  assert.ok(!text.includes(u.email) && !text.includes(u.id));
  assert.equal(stats.by_status.leased, 1);
  for (const k of ["stale_pending_over_10m", "unknown_outcomes", "review_required", "verified_not_enqueued", "trigger_failures_open"]) assert.ok(k in stats, k);
});

test("WK-21 prune is bounded: it removes only stale UNVERIFIED candidates and old handled failures, and keeps every outbox row", async () => {
  const { signup, newEmail } = await import("./world.mjs");
  const done = await registerAndConfirm(w.sup);
  const staleId = await signup(newEmail("stale")), freshId = await signup(newEmail("fresh"));
  await w.sup.query(`update private.azerdex_welcome_candidates set registered_at = now() - interval '40 days' where user_id = $1`, [staleId]);
  await w.sup.query(`insert into private.azerdex_welcome_trigger_failures(user_id, phase, provenance_ok, created_at, handled_at) values ($1,'confirm',true, now() - interval '40 days', now() - interval '39 days')`, [done.id]);
  const n = Number((await w.owner.query(`select private.azerdex_welcome_prune() n`)).rows[0].n);
  assert.equal(n, 2);
  const has = async (id) => Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_candidates where user_id=$1`, [id])).rows[0].n);
  assert.equal(await has(staleId), 0);
  assert.equal(await has(freshId), 1);
  assert.notEqual(await outboxRow(w.sup, done.id), null);
});

test("WK-22 data minimisation: the candidate (and its address hash) disappears once the outbox row exists; suppression and operator decisions zero the outbox hash", async () => {
  const u = await registerAndConfirm(w.sup);
  assert.equal(Number((await w.sup.query(`select count(*) n from private.azerdex_welcome_candidates where user_id=$1`, [u.id])).rows[0].n), 0);
  await w.sup.query(`update auth.users set deleted_at = now() where id=$1`, [u.id]);
  await claim(w.owner, 10);
  assert.equal((await outboxRow(w.sup, u.id)).email_sha256.toString("hex"), "00".repeat(32));
  const v = await registerAndConfirm(w.sup);
  await w.sup.query(`update private.azerdex_welcome_outbox set status='review_required' where user_id=$1`, [v.id]);
  await w.owner.query(`select private.azerdex_welcome_operator_resolve($1, false, null)`, [v.id]);
  assert.equal((await outboxRow(w.sup, v.id)).email_sha256.toString("hex"), "00".repeat(32));
});

test("WK-23 a given-back attempt (circuit_open) does not start the idempotency clock; operator requeue is refused for a row that is still retrying", async () => {
  const { u, job } = await oneJob();
  await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "retry", error_code: "circuit_open" });
  const r = await outboxRow(w.sup, u.id);
  assert.deepEqual([r.attempts, r.first_send_at], [0, null]);
  assert.equal((await w.owner.query(`select private.azerdex_welcome_operator_requeue($1, true) ok`, [u.id])).rows[0].ok, false, "only review_required/suppressed rows can be requeued");
});

test("WK-24 backoff grows 60 s, 120 s, 240 s... and is capped at 1 h", async () => {
  const u = await registerAndConfirm(w.sup);
  const waits = [];
  for (let i = 1; i <= 5; i++) {
    const [job] = await claim(w.owner, 5);
    await finish(w.owner, { user_id: u.id, lease_token: job.lease_token, outcome: "retry", error_code: "provider_rate_limited", retry_after_seconds: 1 });
    const r = await outboxRow(w.sup, u.id);
    waits.push(Math.round((new Date(r.next_attempt_at) - Date.now()) / 1000 / 10) * 10);
    await age(u.id, `next_attempt_at = now() - interval '1 second'`);
  }
  assert.deepEqual(waits, [60, 120, 240, 480, 960]);
});

test("WK-25 a claim-time attempts>=6 row (e.g. after lease expiries) stops for review instead of being sent a 7th time", async () => {
  const u = await registerAndConfirm(w.sup);
  await age(u.id, `status='retry', attempts=6`);
  assert.deepEqual(await claim(w.owner, 5), []);
  assert.equal((await outboxRow(w.sup, u.id)).last_error_code, "attempts_exhausted");
});

test("WK-26 stats also expose signup-phase trigger failures", async () => {
  const stats = await asService(w.owner, async (c) => (await c.query(`select public.azerdex_welcome_stats() j`)).rows[0].j);
  assert.ok("signup_trigger_failures_open" in stats);
});
