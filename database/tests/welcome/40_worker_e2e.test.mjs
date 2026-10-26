// The production worker code (supabase/functions/azerdex-welcome-worker) against the real database functions and real GoTrue accounts,
// with Resend mocked. Proves the pieces fit and that one event yields at most one provider call per attempt, even with parallel workers.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openWorld, resetWelcome, setSwitches, registerAndConfirm, outboxRow, claim, finish, connect, gotrue, adminToken, asService } from "./world.mjs";
import { loadConfig } from "../../../supabase/functions/azerdex-welcome-worker/config.ts";
import { runOnce } from "../../../supabase/functions/azerdex-welcome-worker/worker.ts";
import { makePng, env, jsonResponse } from "../../../tests/welcome-worker/fixtures.mjs";

let w;
before(async () => (w = await openWorld()));
after(async () => w?.close());
beforeEach(async () => {
  await resetWelcome(w.sup);
  await setSwitches(w.owner, { enqueue: true, dispatch: true });
});

const dbFor = (client) => ({
  claim: (limit) => claim(client, limit),
  finish: (a) => finish(client, a),
});
function mockResend(handler) {
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to[0], key: init.headers["idempotency-key"], body });
    return handler(sent.length, body, init);
  };
  return { sent, fetch };
}
const deps = (client, resend, over = {}) => ({ cfg: loadConfig(env(over)), db: dbFor(client), fetch: resend.fetch, loadLogoBytes: async () => makePng(), log: () => {} });

test("E2E-1 a verified account is welcomed once: first run sends, later runs and repeat confirmations send nothing", async () => {
  const u = await registerAndConfirm(w.sup);
  const resend = mockResend(() => jsonResponse(200, { id: "re_e2e_000000001" }));
  const s1 = await runOnce(deps(w.owner, resend));
  assert.deepEqual([s1.state, s1.sent], ["ok", 1]);
  assert.equal(resend.sent.length, 1);
  assert.equal(resend.sent[0].to, u.email);
  assert.equal(resend.sent[0].key, `azerdex-welcome-v1:${u.id}:1`);
  assert.equal(resend.sent[0].body.attachments[0].content_id, "azerdex-logo");
  const r = await outboxRow(w.sup, u.id);
  assert.equal([r.status, r.provider_message_id].join(), "sent,re_e2e_000000001");
  await runOnce(deps(w.owner, resend));
  await gotrue("/token?grant_type=password", { body: { email: u.email, password: "Welcome-Passw0rd-7788!" } });
  await runOnce(deps(w.owner, resend));
  assert.equal(resend.sent.length, 1);
});

test("E2E-2 parallel workers: every event is sent exactly once across 3 concurrent runs", async () => {
  const users = [];
  for (let i = 0; i < 9; i++) users.push(await registerAndConfirm(w.sup));
  const clients = [w.owner, await connect(), await connect()];
  const resend = mockResend(async () => { await new Promise((r) => setTimeout(r, 15)); return jsonResponse(200, { id: `re_e2e_${String(Math.random()).slice(2, 12)}` }); });
  try {
    await Promise.all(clients.map((c) => runOnce(deps(c, resend))));
    await runOnce(deps(w.owner, resend));
  } finally {
    await clients[1].end();
    await clients[2].end();
  }
  const tos = resend.sent.map((s) => s.to).sort();
  assert.deepEqual(tos, users.map((u) => u.email).sort(), "each recipient exactly once");
  const rows = (await w.sup.query(`select status from private.azerdex_welcome_outbox`)).rows;
  assert.ok(rows.every((r) => r.status === "sent"));
});

test("E2E-3 Resend 429 then success: retried after the wait with the same idempotency key; delivery recorded once", async () => {
  const u = await registerAndConfirm(w.sup);
  const resend = mockResend((n) => (n === 1 ? jsonResponse(429, {}, { "retry-after": "5" }) : jsonResponse(200, { id: "re_e2e_000000002" })));
  assert.equal((await runOnce(deps(w.owner, resend))).retry, 1);
  assert.equal((await outboxRow(w.sup, u.id)).status, "retry");
  assert.equal((await runOnce(deps(w.owner, resend))).claimed, 0, "not due yet");
  await w.sup.query(`update private.azerdex_welcome_outbox set next_attempt_at = now() where user_id=$1`, [u.id]);
  assert.equal((await runOnce(deps(w.owner, resend))).sent, 1);
  assert.equal(resend.sent.length, 2);
  assert.equal(resend.sent[0].key, resend.sent[1].key);
});

test("E2E-4 provider timeout: unknown outcome, same key retried inside the window, then stopped for review after it", async () => {
  const u = await registerAndConfirm(w.sup);
  const hang = mockResend((_n, _b, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))));
  const d = deps(w.owner, hang);
  d.cfg.sendTimeoutMs = 30;
  assert.equal((await runOnce(d)).ambiguous, 1);
  let r = await outboxRow(w.sup, u.id);
  assert.deepEqual([r.status, r.unknown_outcome, r.last_error_code], ["retry", true, "provider_timeout"]);
  await w.sup.query(`update private.azerdex_welcome_outbox set next_attempt_at = now(), first_send_at = now() - interval '21 hours' where user_id=$1`, [u.id]);
  const s = await runOnce(d);
  assert.equal(s.claimed, 0, "past the idempotency window nothing is auto-retried");
  r = await outboxRow(w.sup, u.id);
  assert.deepEqual([r.status, r.last_error_code], ["review_required", "idempotency_window_elapsed"]);
  assert.equal(hang.sent.length, 1);
});

test("E2E-5 worker crash between send and finish: the expired lease is an unknown outcome, retried with the SAME key (provider dedups)", async () => {
  const u = await registerAndConfirm(w.sup);
  const crashing = mockResend(() => jsonResponse(200, { id: "re_e2e_000000003" }));
  const d = deps(w.owner, crashing);
  d.db.finish = async () => { throw new Error("worker died"); };
  await runOnce(d);
  assert.equal((await outboxRow(w.sup, u.id)).status, "leased");
  await w.sup.query(`update private.azerdex_welcome_outbox set lease_until = now() - interval '1 second' where user_id=$1`, [u.id]);
  const healthy = mockResend(() => jsonResponse(200, { id: "re_e2e_000000003" }));
  await runOnce(deps(w.owner, healthy));
  assert.equal(healthy.sent[0].key, crashing.sent[0].key);
  assert.equal((await outboxRow(w.sup, u.id)).status, "sent");
});

test("E2E-6 stale account states between enqueue and dispatch send NOTHING (deleted / unverified / e-mail changed)", async () => {
  const gone = await registerAndConfirm(w.sup);
  const unv = await registerAndConfirm(w.sup);
  const moved = await registerAndConfirm(w.sup);
  await gotrue(`/admin/users/${gone.id}`, { method: "DELETE", token: adminToken(), body: { should_soft_delete: true } });
  await w.sup.query(`update auth.users set email_confirmed_at = null where id=$1`, [unv.id]);
  await w.sup.query(`update auth.users set email = 'moved-' || email where id=$1`, [moved.id]);
  const resend = mockResend(() => jsonResponse(200, { id: "re_e2e_000000004" }));
  const s = await runOnce(deps(w.owner, resend));
  assert.equal(resend.sent.length, 0);
  assert.equal(s.claimed, 0);
  const st = (await w.sup.query(`select status, last_error_code from private.azerdex_welcome_outbox order by last_error_code`)).rows;
  assert.deepEqual(st.map((r) => r.last_error_code).sort(), ["email_changed", "ineligible_deleted", "ineligible_unverified"]);
});

test("E2E-7 feature flags: worker flag OFF or database dispatch OFF each prevent every send, and nothing is consumed", async () => {
  const u = await registerAndConfirm(w.sup);
  const resend = mockResend(() => jsonResponse(200, { id: "re_e2e_000000005" }));
  assert.equal((await runOnce(deps(w.owner, resend, { AZERDEX_WELCOME_ENABLED: "false" }))).state, "disabled");
  await setSwitches(w.owner, { dispatch: false });
  assert.equal((await runOnce(deps(w.owner, resend))).claimed, 0);
  assert.equal(resend.sent.length, 0);
  const r = await outboxRow(w.sup, u.id);
  assert.deepEqual([r.status, r.attempts], ["pending", 0]);
});

test("E2E-8 password recovery of an unconfirmed signup produces no mail at all through the whole pipeline", async () => {
  const { signup, oneTimeToken, verify, newEmail } = await import("./world.mjs");
  const email = newEmail("rec");
  await signup(email);
  await gotrue("/recover", { body: { email } });
  assert.equal((await verify("recovery", await oneTimeToken(w.sup, email, "recovery_token"))).status, 200);
  const resend = mockResend(() => jsonResponse(200, { id: "re_e2e_000000006" }));
  await runOnce(deps(w.owner, resend));
  assert.equal(resend.sent.length, 0);
});
