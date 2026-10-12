import { randomBytes, randomInt } from "node:crypto";
import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
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
export async function companionWithInstallation(o: { guilds?: number; members?: number; tag?: string; sources?: number } = {}): Promise<Companion> {
  await relaxFixtureCeilings();
  const id = await anonymous();
  const installationId = uniq("e2e");
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
