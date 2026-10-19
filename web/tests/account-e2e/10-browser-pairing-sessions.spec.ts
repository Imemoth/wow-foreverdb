import { expect, test } from "@playwright/test";
import type { PlaywrightWorkerArgs } from "@playwright/test";
import type pg from "pg";
import { admin, anonymous, auth, claimsOf, registeredSession, resetBudgets, rpc, superAdmin } from "./stack";
import { json, makePairingDue, nativePairingPost, newClient, openPairing, pairingDecision, pairingMaterial, webUser } from "./world";

test.use({ trace: "off" });

let db: pg.Client;
let observer: pg.Client;
test.beforeAll(async () => { db = await admin(); observer = await superAdmin(); });
test.afterAll(async () => { await observer?.end(); await db?.end(); });
test.beforeEach(async () => { await resetBudgets(db); });

async function assertLive(token: string, refresh: string, anonymousExpected: boolean) {
  const claims = claimsOf(token);
  expect(claims.session_id).toMatch(/^[0-9a-f-]{36}$/);
  const row = (await db.query(`select s.user_id,u.is_anonymous,
    exists(select 1 from auth.refresh_tokens r where r.session_id=s.id and not r.revoked) refresh_live
    from auth.sessions s join auth.users u on u.id=s.user_id where s.id=$1`, [claims.session_id])).rows[0];
  expect(row).toMatchObject({ user_id: claims.sub, is_anonymous: anonymousExpected, refresh_live: true });
  expect(refresh).toBeTruthy();
}

test("real GoTrue validity and refresh rotation preserve the exact pairing session", async ({ playwright }) => {
  const native = await newClient(playwright);
  const initiator = await anonymous();
  const account = await webUser(playwright, "pairSession");
  await assertLive(initiator.token, initiator.refresh, true);
  await assertLive(account.accessToken, (await (await import("../account/helpers")).openSessionCookie((await (await import("../account/helpers")).cookieOf(account.c))!.value))!.rt, false);
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  await new Promise((r) => setTimeout(r, 1100));
  const rotated = await auth("/token?grant_type=refresh_token", { body: { refresh_token: initiator.refresh } });
  expect(rotated.status).toBe(200);
  expect(rotated.body.refresh_token).not.toBe(initiator.refresh);
  expect(claimsOf(rotated.body.access_token).session_id).toBe(initiator.sid);
  const current = { ...initiator, token: rotated.body.access_token, refresh: rotated.body.refresh_token };
  const rendered = await openPairing(account.c, p.pairingId);
  expect((await pairingDecision(account.c, "approve", p.pairingId, rendered.pageBinding)).status()).toBe(200);
  await makePairingDue(db, p.pairingId);
  expect(await json(await nativePairingPost(native, "poll", current, p))).toEqual({ ok: true, state: "connected", deviceId: p.deviceId });
});

test("old refresh-token replay revokes the family and the unexpired access JWT cannot mutate", async ({ playwright }) => {
  const native = await newClient(playwright);
  const initiator = await anonymous();
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  await new Promise((r) => setTimeout(r, 1100));
  const one = await auth("/token?grant_type=refresh_token", { body: { refresh_token: initiator.refresh } });
  await new Promise((r) => setTimeout(r, 1100));
  const two = await auth("/token?grant_type=refresh_token", { body: { refresh_token: one.body.refresh_token } });
  expect(two.status).toBe(200);
  await new Promise((r) => setTimeout(r, 11_000));
  expect((await auth("/token?grant_type=refresh_token", { body: { refresh_token: initiator.refresh } })).status).toBe(400);
  const stillUnexpired = { token: two.body.access_token };
  expect(claimsOf(two.body.access_token).exp * 1000).toBeGreaterThan(Date.now());
  const before = (await db.query("select to_jsonb(p) row from private.device_pairings p where id=$1", [p.pairingId])).rows[0].row;
  const refused = await nativePairingPost(native, "cancel", stillUnexpired, p);
  expect(refused.status()).toBe(409);
  expect(await json(refused)).toEqual({ ok: false, error: "pairing_not_available" });
  expect((await db.query("select to_jsonb(p) row from private.device_pairings p where id=$1", [p.pairingId])).rows[0].row).toEqual(before);
});

test("initiator logout and same-UID session substitution cannot poll or cancel", async ({ playwright }) => {
  const native = await newClient(playwright);
  const initiator = await anonymous();
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  expect((await auth("/logout?scope=local", { token: initiator.token })).status).toBe(204);
  for (const action of ["poll", "cancel"] as const) {
    const r = await nativePairingPost(native, action, initiator, p);
    expect(r.status()).toBe(409);
    expect(await json(r)).toEqual({ ok: false, error: "pairing_not_available" });
  }
});

test("approver logout before redemption denies atomically and another live session of the UID cannot substitute", async ({ playwright }) => {
  const native = await newClient(playwright);
  const initiator = await anonymous();
  const account = await webUser(playwright, "pairApproverLogout");
  const other = await registeredSession(account.email, account.password);
  expect(other.uid).toBe(account.uid);
  expect(other.sid).not.toBe(account.sid);
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const rendered = await openPairing(account.c, p.pairingId);
  expect((await pairingDecision(account.c, "approve", p.pairingId, rendered.pageBinding)).status()).toBe(200);
  expect((await auth("/logout?scope=local", { token: account.accessToken })).status).toBe(204);
  expect((await rpc(other.token, "fdb_account_device_pair_preview", { p_pairing_id: p.pairingId })).status).toBe(200);
  await makePairingDue(db, p.pairingId);
  expect(await json(await nativePairingPost(native, "poll", initiator, p))).toEqual({ ok: true, state: "denied" });
  expect((await db.query("select denied_reason from private.device_pairings where id=$1", [p.pairingId])).rows[0].denied_reason).toBe("approval_session_revoked");
  expect((await db.query("select count(*)::int n from private.devices where pairing_id=$1", [p.pairingId])).rows[0].n).toBe(0);
});

interface RaceCase {
  name: "start" | "cancel" | "approve" | "deny" | "redemption";
  initiator: Awaited<ReturnType<typeof anonymous>>;
  account?: Awaited<ReturnType<typeof webUser>>;
  pairing: ReturnType<typeof pairingMaterial>;
  token: string;
  rpcName: string;
  args: Record<string, unknown>;
  logoutToken: string;
}

async function raceCase(playwright: PlaywrightWorkerArgs["playwright"], name: RaceCase["name"]): Promise<RaceCase> {
  await resetBudgets(db);
  const initiator = await anonymous();
  const pairing = pairingMaterial();
  let account: Awaited<ReturnType<typeof webUser>> | undefined;
  if (name !== "start") {
    expect((await rpc(initiator.token, "fdb_device_pair_start", {
      p_pairing_id: pairing.pairingId, p_poll_secret_hash: pairing.pollSecretHash, p_device_id: pairing.deviceId,
      p_device_credential_hash: pairing.deviceCredentialHash, p_installation_id: pairing.installationId, p_computer_name: pairing.computerName,
    })).body.ok).toBe(true);
  }
  if (name === "approve" || name === "deny" || name === "redemption") account = await webUser(playwright, `race-${name}`);
  if (name === "redemption") {
    expect((await rpc(account!.accessToken, "fdb_account_device_pair_approve", { p_pairing_id: pairing.pairingId })).body).toEqual({ ok: true, state: "approved" });
    await makePairingDue(db, pairing.pairingId);
  }
  if (name === "start") return {
    name, initiator, pairing, token: initiator.token, logoutToken: initiator.token, rpcName: "fdb_device_pair_start",
    args: { p_pairing_id: pairing.pairingId, p_poll_secret_hash: pairing.pollSecretHash, p_device_id: pairing.deviceId,
      p_device_credential_hash: pairing.deviceCredentialHash, p_installation_id: pairing.installationId, p_computer_name: pairing.computerName },
  };
  if (name === "cancel" || name === "redemption") return {
    name, initiator, account, pairing, token: initiator.token, logoutToken: initiator.token,
    rpcName: name === "cancel" ? "fdb_device_pair_cancel" : "fdb_device_pair_poll",
    args: { p_pairing_id: pairing.pairingId, p_poll_secret: pairing.pollSecret },
  };
  return {
    name, initiator, account, pairing, token: account!.accessToken, logoutToken: account!.accessToken,
    rpcName: `fdb_account_device_pair_${name}`, args: { p_pairing_id: pairing.pairingId },
  };
}

async function waitForRpcLock(needle: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // pg_stat_activity hides another login role's query text from the migration
    // role. The disposable-cluster superuser is observation-only here; product
    // calls still travel through PostgREST as the authenticated role.
    const r = await observer.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike $1) blocked", [`%${needle}%`]);
    if (r.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${needle} never reached the expected database lock`);
}

async function protectedPairingState(p: RaceCase["pairing"]) {
  return (await db.query(`select jsonb_build_object(
    'pair',(select to_jsonb(x) from private.device_pairings x where id=$1),
    'owner',(select owner_user_id from public.installations where id=$2),
    'devices',(select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]') from private.devices d where pairing_id=$1),
    'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from private.device_pairing_audit a where pairing_audit_ref=(select audit_ref from private.device_pairings where id=$1))
  ) state`, [p.pairingId, p.installationId])).rows[0].state;
}

test("real-GoTrue revocation wins before the post-installation session recheck for start, cancel, approve, deny and redemption", async ({ playwright }) => {
  for (const name of ["start", "cancel", "approve", "deny", "redemption"] as const) {
    const c = await raceCase(playwright, name);
    const holder = await admin();
    await holder.query("begin");
    await holder.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [c.pairing.installationId]);
    const before = await protectedPairingState(c.pairing);
    const mutation = rpc(c.token, c.rpcName, c.args);
    try {
      await waitForRpcLock(c.rpcName);
      expect((await auth("/logout?scope=local", { token: c.logoutToken })).status).toBe(204);
      await holder.query("commit");
      const result = await mutation;
      expect(result.status).toBe(200);
      expect(result.body).toEqual(name === "start" ? { ok: false, error: "session_not_accepted" }
        : name === "approve" || name === "deny" ? { ok: false, error: "unauthenticated" }
        : { ok: false, error: "pairing_not_available" });
      expect(await protectedPairingState(c.pairing)).toEqual(before);
    } finally {
      await holder.query("rollback").catch(() => {});
      await mutation.catch(() => {});
      await holder.end();
    }
  }
});

test("the inverse race pins the exact session through commit, then real-GoTrue logout completes", async ({ playwright }) => {
  for (const name of ["start", "cancel", "approve", "deny", "redemption"] as const) {
    const c = await raceCase(playwright, name);
    const holder = await admin();
    await holder.query("begin");
    if (name === "start") await holder.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`fdb-device-identity:${c.initiator.uid}`]);
    else await holder.query("select 1 from private.device_pairings where id=$1 for update", [c.pairing.pairingId]);
    const mutation = rpc(c.token, c.rpcName, c.args);
    try {
      await waitForRpcLock(c.rpcName);
      let logoutSettled = false;
      const logout = auth("/logout?scope=local", { token: c.logoutToken }).then((r) => { logoutSettled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(logoutSettled, `${name} must pin its exact session until commit`).toBe(false);
      await holder.query("commit");
      const result = await mutation;
      expect(result.status).toBe(200);
      if (name === "start") expect(result.body).toMatchObject({ ok: true, state: "pending", pairingId: c.pairing.pairingId });
      else if (name === "cancel" || name === "deny") expect(result.body).toEqual({ ok: true, state: "denied" });
      else if (name === "approve") expect(result.body).toEqual({ ok: true, state: "approved" });
      else expect(result.body).toEqual({ ok: true, state: "connected", deviceId: c.pairing.deviceId });
      expect((await logout).status).toBe(204);
    } finally {
      await holder.query("rollback").catch(() => {});
      await mutation.catch(() => {});
      await holder.end();
    }
  }
});
