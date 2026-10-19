import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import type pg from "pg";
import { PASSWORD, cookieOf, json, newClient, openSessionCookie, post, signedInClient, uniqueEmail, waitForMail } from "../account/helpers";
import { anonymous, claimsOf, ingest, relaxFixtureCeilings, rpc, snapshot, type Identity, uniq } from "./stack";

type Playwright = PlaywrightWorkerArgs["playwright"];
export { PASSWORD, json, newClient, post, uniqueEmail, waitForMail, cookieOf, openSessionCookie };

export interface WebUser { c: APIRequestContext; email: string; password: string; uid: string; sid: string; accessToken: string }

/** Registers on the website, confirms through the CAPTURED e-mail, and returns the signed-in website client (a real web session). */
export async function webUser(playwright: Playwright, tag: string): Promise<WebUser> {
  // every account gets its OWN password (a shared constant would make "the password of account B" indistinguishable from A's)
  const { c, email, password } = await signedInClient(playwright, tag, `${PASSWORD} ${tag} ${randomBytes(5).toString("hex")}`);
  const ck = await cookieOf(c);
  const s = await openSessionCookie(ck!.value);
  if (!s) throw new Error("web session cookie could not be opened");
  return { c, email: email.toLowerCase(), password, uid: s.uid, sid: s.sid, accessToken: s.at };
}

/** A fresh browser-like client signed in as an EXISTING account (a second, independent web session of that account). */
export async function loginAgain(playwright: Playwright, u: Pick<WebUser, "email" | "password">): Promise<WebUser> {
  const c = await newClient(playwright);
  const r = await post(c, "/account/api/login", { email: u.email, password: u.password });
  if (r.status() !== 200) throw new Error(`login answered ${r.status()}: ${await r.text()}`);
  const s = (await openSessionCookie((await cookieOf(c))!.value))!;
  return { c, email: u.email.toLowerCase(), password: u.password, uid: s.uid, sid: s.sid, accessToken: s.at };
}

export interface Companion { id: Identity; installationId: string }

/** An anonymous Companion identity that has really ingested one installation (sources, loot, locations, quest drops, Guildbook). */
export async function companionWithInstallation(o: { guilds?: number; members?: number; tag?: string; sources?: number; installationId?: string } = {}): Promise<Companion> {
  await relaxFixtureCeilings();
  const id = await anonymous();
  const installationId = o.installationId ?? uniq("e2e");
  const r = await ingest(id.token, snapshot(installationId, { updatedAt: 1000, sources: o.sources ?? 3, guilds: o.guilds ?? 2, members: o.members ?? 4, tag: o.tag ?? "M" }));
  if (r.status !== 200 || r.body?.ok !== true) throw new Error(`ingest answered ${r.status} ${JSON.stringify(r.body)}`);
  return { id, installationId };
}

export async function startClaim(c: Companion): Promise<string> {
  await relaxFixtureCeilings();
  const r = await rpc(c.id.token, "fdb_account_claim_start", { p_installation_id: c.installationId });
  if (r.status !== 200 || r.body?.ok !== true) throw new Error(`claim start answered ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.code as string;
}

/** POST /account/api/link exactly as the page does (signed CSRF, same-origin). */
export async function link(c: APIRequestContext, code: string, password: string, accountId?: string): Promise<APIResponse> {
  // the page sends the id of the account it displayed; by default that is the account the client's session belongs to
  const ck = await cookieOf(c);
  const s = ck ? await openSessionCookie(ck.value) : null;
  return post(c, "/account/api/link", { code, password, confirm: true, accountId: accountId ?? s?.uid ?? "00000000-0000-4000-8000-000000000000" });
}
export { claimsOf };

/** A client that presents exactly this session cookie (a thief with a copied browser state), with a working CSRF cookie jar of its own. */
export async function clientWithSessionCookie(playwright: Playwright, value: string, ip = `203.0.113.${randomInt(1, 251)}`): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: "http://localhost:3210",
    extraHTTPHeaders: { "x-forwarded-for": ip },
    storageState: { cookies: [{ name: "fdb_acct", value, domain: "localhost", path: "/account", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [] },
  });
}

// ------------------------------------------------------------------------------------------------ Browser Pairing V1
export interface PairingMaterial {
  pairingId: string;
  pollSecret: string;
  pollSecretHash: string;
  deviceId: string;
  deviceCredential: string;
  deviceCredentialHash: string;
  installationId: string;
  computerName: string;
}

export function pairingMaterial(overrides: Partial<PairingMaterial> = {}): PairingMaterial {
  const pairingId = randomUUID();
  const deviceId = randomUUID();
  const pollSecret = `fdbp1_${randomBytes(32).toString("base64url")}`;
  const deviceCredential = `fdbd1_${deviceId.replaceAll("-", "")}_${randomBytes(32).toString("base64url")}`;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return {
    pairingId,
    pollSecret,
    pollSecretHash: digest(pollSecret),
    deviceId,
    deviceCredential,
    deviceCredentialHash: digest(deviceCredential),
    installationId: randomBytes(16).toString("hex"),
    computerName: "Task 9 Test PC",
    ...overrides,
  };
}

export async function nativePairingPost(
  c: APIRequestContext,
  action: "start" | "poll" | "cancel",
  identity: Pick<Identity, "token">,
  pairing: PairingMaterial,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  const data = action === "start"
    ? { pairingId: pairing.pairingId, pollSecretHash: pairing.pollSecretHash, deviceId: pairing.deviceId,
        deviceCredentialHash: pairing.deviceCredentialHash, installationId: pairing.installationId, computerName: pairing.computerName }
    : { pairingId: pairing.pairingId, pollSecret: pairing.pollSecret };
  return c.post(`/account/api/device-pair/${action}`, {
    headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json", ...headers },
    data: JSON.stringify(data),
  });
}

/** Follow the one-shot locator intake and return the rendered opaque page/session binding. */
export async function openPairing(c: APIRequestContext, pairingId: string): Promise<{ html: string; pageBinding: string }> {
  const intake = await c.get(`/account/device-pair?request=${pairingId}`);
  if (intake.status() !== 200) throw new Error(`pairing intake answered ${intake.status()}: ${await intake.text()}`);
  const html = await intake.text();
  const m = /fdbpg1_[A-Za-z0-9_-]{43}/.exec(html);
  if (!m) throw new Error("rendered pairing page has no opaque page binding");
  return { html, pageBinding: m[0] };
}

export async function pairingDecision(
  c: APIRequestContext,
  action: "approve" | "deny",
  pairingId: string,
  pageBinding: string,
  options: { origin?: string | null; fetchSite?: string | null; csrf?: "auto" | "none" | string; raw?: string } = {},
): Promise<APIResponse> {
  const headers: Record<string, string> = { "x-fdb-pairing-page": pageBinding };
  const origin = options.origin === undefined ? "http://localhost:3210" : options.origin;
  if (origin !== null) headers.origin = origin;
  const site = options.fetchSite === undefined ? "same-origin" : options.fetchSite;
  if (site !== null) headers["sec-fetch-site"] = site;
  const csrf = options.csrf === "none" ? null : options.csrf && options.csrf !== "auto" ? options.csrf : await (await import("../account/helpers")).csrfToken(c);
  if (csrf) headers["x-fdb-csrf"] = csrf;
  return c.post(`/account/api/device-pair/${action}`, {
    headers: { ...headers, "content-type": "application/json" },
    data: options.raw ?? JSON.stringify({ pairingId }),
  });
}

export async function makePairingDue(db: pg.Client, pairingId: string): Promise<void> {
  await db.query("update private.device_pairings set next_poll_at=clock_timestamp()-interval '1 second' where id=$1", [pairingId]);
}
