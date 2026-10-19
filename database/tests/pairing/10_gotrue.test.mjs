// Mandatory Browser Pairing session-lifecycle gate. Every identity and session in this file is issued
// and revoked by the pinned real GoTrue process; absence of GoTrue is a hard test failure.
import { after, before, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { rpc, verifyJwt } from "../account/harness.mjs";
import {
  due,
  makePairingWorld,
  pairRow,
  pairingInput,
  startArgs,
  startPairingAuth,
} from "./world.mjs";

const PASSWORD = "Correct-horse-battery-1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let w;
let auth;

before(async () => {
  w = await makePairingWorld();
  auth = await startPairingAuth(w);
});
after(async () => {
  await auth?.close();
  await w?.close();
});
beforeEach(async () => w.fx.resetBudgets());

function session(json) {
  const claims = verifyJwt(json.access_token);
  return {
    token: json.access_token,
    refresh: json.refresh_token,
    claims,
    uid: claims.sub,
    sid: claims.session_id,
    call(name, args = []) { return rpc(w.client, verifyJwt(this.token), name, args); },
  };
}

async function anonymous() {
  const reply = await auth.call("/signup", { body: {} });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  return session(reply.json);
}

async function registered(tag = "account") {
  const email = `${tag}-${crypto.randomUUID()}@example.invalid`;
  const reply = await auth.call("/signup", { body: { email, password: PASSWORD } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  return { ...session(reply.json), email };
}

async function login(email) {
  const reply = await auth.call("/token?grant_type=password", { body: { email, password: PASSWORD } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  return session(reply.json);
}

async function start(initiator, input = pairingInput()) {
  const out = await initiator.call("fdb_device_pair_start", startArgs(input));
  assert.equal(out.ok, true, JSON.stringify(out));
  return input;
}

async function liveSession(sessionValue, anonymousExpected) {
  assert.match(sessionValue.sid, UUID);
  assert.equal(sessionValue.claims.session_id, sessionValue.sid);
  assert.equal(sessionValue.claims.is_anonymous, anonymousExpected);
  const row = (await w.admin.query(
    `select s.user_id, s.not_after, u.is_anonymous,
       exists(select 1 from auth.refresh_tokens r where r.session_id=s.id and not r.revoked) refresh_live
     from auth.sessions s join auth.users u on u.id=s.user_id where s.id=$1`,
    [sessionValue.sid],
  )).rows[0];
  assert.equal(row.user_id, sessionValue.uid);
  assert.equal(row.not_after, null);
  assert.equal(row.is_anonymous, anonymousExpected);
  assert.equal(row.refresh_live, true);
}

it("real GoTrue issues live exact sessions for anonymous initiators and registered approvers", async () => {
  await liveSession(await anonymous(), true);
  await liveSession(await registered("valid"), false);
});

it("normal refresh rotates the token, preserves session_id, and continues the same pairing", async () => {
  const initiator = await anonymous();
  const pairing = await start(initiator);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const reply = await auth.call("/token?grant_type=refresh_token", { body: { refresh_token: initiator.refresh } });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  const rotated = session(reply.json);
  assert.equal(rotated.sid, initiator.sid);
  assert.notEqual(rotated.token, initiator.token);
  assert.notEqual(rotated.refresh, initiator.refresh);
  await liveSession(rotated, true);
  await due(w, pairing);
  const polled = await rotated.call("fdb_device_pair_poll", [pairing.id, pairing.secret]);
  assert.deepEqual(polled, { ok: true, state: "pending", intervalSeconds: 5, expiresAt: polled.expiresAt });
  assert.match(polled.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
});

it("refresh-token reuse revokes the family and the still-valid JWT cannot mutate pairing", async () => {
  const initiator = await anonymous();
  const pairing = await start(initiator);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const first = await auth.call("/token?grant_type=refresh_token", { body: { refresh_token: initiator.refresh } });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const second = await auth.call("/token?grant_type=refresh_token", { body: { refresh_token: first.json.refresh_token } });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  const newest = session(second.json);
  await new Promise((resolve) => setTimeout(resolve, 11_000));
  const replay = await auth.call("/token?grant_type=refresh_token", { body: { refresh_token: initiator.refresh } });
  assert.equal(replay.status, 400, JSON.stringify(replay.json));
  assert.equal((await w.admin.query("select count(*)::int n from auth.sessions where id=$1", [initiator.sid])).rows[0].n, 1);
  assert.equal((await w.admin.query("select count(*)::int n from auth.refresh_tokens where session_id=$1 and not revoked", [initiator.sid])).rows[0].n, 0);
  assert.ok(newest.claims.exp * 1000 > Date.now(), "the access JWT is still cryptographically unexpired");
  const before = await pairRow(w, pairing);
  assert.deepEqual(await newest.call("fdb_device_pair_cancel", [pairing.id, pairing.secret]), { ok: false, error: "pairing_not_available" });
  assert.deepEqual(await pairRow(w, pairing), before);
});

it("local logout invalidates the initiator's unexpired JWT for poll and cancel without pairing mutation", async () => {
  const initiator = await anonymous();
  const pairing = await start(initiator);
  const before = await pairRow(w, pairing);
  const logout = await auth.call("/logout?scope=local", { token: initiator.token });
  assert.equal(logout.status, 204, JSON.stringify(logout.json));
  assert.ok(initiator.claims.exp * 1000 > Date.now());
  assert.equal((await w.admin.query("select count(*)::int n from auth.sessions where id=$1", [initiator.sid])).rows[0].n, 0);
  assert.deepEqual(await initiator.call("fdb_device_pair_poll", [pairing.id, pairing.secret]), { ok: false, error: "pairing_not_available" });
  assert.deepEqual(await initiator.call("fdb_device_pair_cancel", [pairing.id, pairing.secret]), { ok: false, error: "pairing_not_available" });
  assert.deepEqual(await pairRow(w, pairing), before);
});

it("a live same-UID session cannot replace the exact approver session after logout", async () => {
  const initiator = await anonymous();
  const approver = await registered("substitution");
  const substitute = await login(approver.email);
  assert.equal(substitute.uid, approver.uid);
  assert.notEqual(substitute.sid, approver.sid);
  const pairing = await start(initiator);
  assert.deepEqual(await approver.call("fdb_account_device_pair_approve", [pairing.id]), { ok: true, state: "approved" });
  assert.equal((await auth.call("/logout?scope=local", { token: approver.token })).status, 204);
  await liveSession(substitute, false);
  await due(w, pairing);
  assert.deepEqual(await initiator.call("fdb_device_pair_poll", [pairing.id, pairing.secret]), { ok: true, state: "denied" });
  const row = await pairRow(w, pairing);
  assert.equal(row.denied_reason, "approval_session_revoked");
  assert.equal(await w.fx.owner(pairing.installationId), null);
  assert.equal((await w.admin.query("select count(*)::int n from private.devices where pairing_id=$1", [pairing.id])).rows[0].n, 0);
});
