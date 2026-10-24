import { expect, test } from "@playwright/test";
import { companionWithInstallation, webUser } from "./world";
import { admin, anonymous, logoutLocal, registeredSession, rpc } from "./stack";
import type pg from "pg";

/**
 * LS-1..LS-8 repeated THROUGH real PostgREST for every account function (the registry's guards), over the dead-session states:
 * signed out, expired session (`not_after`), deleted user, banned user. A correctly signed, unexpired JWT must never be enough.
 */
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });

const REGISTERED: [string, (i: string) => Record<string, unknown>][] = [
  ["fdb_account_claim_redeem", () => ({ p_code: "0123456789ABCDEF0123456789ABCDEF" })],
  ["fdb_account_installations", () => ({})],
  ["fdb_installation_link_status", (i) => ({ p_installation_id: i })],
];

test("registered functions refuse every dead state with PT401 (never a result), and a live session still works", async ({ playwright }) => {
  const states: [string, (uid: string, sid: string, token: string) => Promise<void>][] = [
    ["signed out", async (_u, _s, t) => { expect(await logoutLocal(t)).toBe(204); }],
    ["session expired (not_after)", async (_u, sid) => { await db.query("update auth.sessions set not_after = now() - interval '1 minute' where id = $1", [sid]); }],
    ["user deleted", async (uid) => { await db.query("update auth.users set deleted_at = now() where id = $1", [uid]); }],
    ["user banned", async (uid) => { await db.query("update auth.users set banned_until = now() + interval '1 hour' where id = $1", [uid]); }],
  ];
  for (const [label, kill] of states) {
    const w = await webUser(playwright, "guard");
    const s = await registeredSession(w.email, w.password);
    for (const [name, args] of REGISTERED) expect((await rpc(s.token, name, args("x-1"))).status, `${name} while alive`).toBe(200);
    await kill(w.uid, s.sid, s.token);
    for (const [name, args] of REGISTERED) {
      const r = await rpc(s.token, name, args("x-1"));
      expect([r.status, r.body.code], `${label}: ${name}`).toEqual([401, "PT401"]);
    }
  }
});

test("LS-1 and the anonymous guard through PostgREST: a signed-out anonymous owner cannot start a claim for its own installation; the live one can", async () => {
  const comp = await companionWithInstallation();
  const live = await rpc(comp.id.token, "fdb_account_claim_start", { p_installation_id: comp.installationId });
  expect([live.status, live.body.ok]).toEqual([200, true]);
  expect(await logoutLocal(comp.id.token)).toBe(204);
  const dead = await rpc(comp.id.token, "fdb_account_claim_start", { p_installation_id: comp.installationId });
  expect([dead.status, dead.body.code]).toEqual([401, "PT401"]);
  expect((await rpc(comp.id.token, "fdb_installation_link_status", { p_installation_id: comp.installationId })).status).toBe(401);
  // and a different anonymous identity (not the owner) gets the single indistinguishable failure
  const other = await anonymous();
  expect((await rpc(other.token, "fdb_account_claim_start", { p_installation_id: comp.installationId })).body).toEqual({ ok: false, error: "not_available" });
});

test("LS-6 at the database layer: a registered caller whose session was revoked cannot redeem a pending claim; the claim stays pending", async ({ playwright }) => {
  const w = await webUser(playwright, "ls6");
  const s = await registeredSession(w.email, w.password);
  const comp = await companionWithInstallation();
  const code = (await rpc(comp.id.token, "fdb_account_claim_start", { p_installation_id: comp.installationId })).body.code as string;
  expect(await logoutLocal(s.token)).toBe(204);
  const r = await rpc(s.token, "fdb_account_claim_redeem", { p_code: code });
  expect([r.status, r.body.code]).toEqual([401, "PT401"]);
  expect((await db.query("select status from private.installation_claims where installation_id = $1", [comp.installationId])).rows).toEqual([{ status: "pending" }]);
});
