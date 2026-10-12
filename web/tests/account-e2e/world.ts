import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";
import { PASSWORD, cookieOf, json, newClient, openSessionCookie, post, signedInClient, uniqueEmail, waitForMail } from "../account/helpers";
import { anonymous, claimsOf, ingest, rpc, snapshot, type Identity, uniq } from "./stack";

type Playwright = PlaywrightWorkerArgs["playwright"];
export { PASSWORD, json, newClient, post, uniqueEmail, waitForMail, cookieOf, openSessionCookie };

export interface WebUser { c: APIRequestContext; email: string; password: string; uid: string; sid: string; accessToken: string }

/** Registers on the website, confirms through the CAPTURED e-mail, and returns the signed-in website client (a real web session). */
export async function webUser(playwright: Playwright, tag: string): Promise<WebUser> {
  // every account gets its OWN password (a shared constant would make "the password of account B" indistinguishable from A's)
  const { c, email, password } = await signedInClient(playwright, tag, `${PASSWORD} ${tag} ${Math.random().toString(36).slice(2, 10)}`);
  const ck = await cookieOf(c);
  const s = await openSessionCookie(ck!.value);
  if (!s) throw new Error("web session cookie could not be opened");
  return { c, email: email.toLowerCase(), password, uid: s.uid, sid: s.sid, accessToken: s.at };
}

/** A fresh browser-like client signed in as an EXISTING account (a second, independent web session of that account). */
export async function loginAgain(playwright: Playwright, u: Pick<WebUser, "email" | "password">): Promise<WebUser> {
  const c = await newClient(playwright);
  const r = await post(c, "/account/api/login", { email: u.email, password: u.password });
  if (r.status() !== 200) throw new Error(`login answered ${r.status()}`);
  const s = (await openSessionCookie((await cookieOf(c))!.value))!;
  return { c, email: u.email.toLowerCase(), password: u.password, uid: s.uid, sid: s.sid, accessToken: s.at };
}

export interface Companion { id: Identity; installationId: string }

/** An anonymous Companion identity that has really ingested one installation (sources, loot, locations, quest drops, Guildbook). */
export async function companionWithInstallation(o: { guilds?: number; members?: number; tag?: string; sources?: number } = {}): Promise<Companion> {
  const id = await anonymous();
  const installationId = uniq("e2e");
  const r = await ingest(id.token, snapshot(installationId, { updatedAt: 1000, sources: o.sources ?? 3, guilds: o.guilds ?? 2, members: o.members ?? 4, tag: o.tag ?? "M" }));
  if (r.status !== 200 || r.body?.ok !== true) throw new Error(`ingest answered ${r.status} ${JSON.stringify(r.body)}`);
  return { id, installationId };
}

export async function startClaim(c: Companion): Promise<string> {
  const r = await rpc(c.id.token, "fdb_account_claim_start", { p_installation_id: c.installationId });
  if (r.status !== 200 || r.body?.ok !== true) throw new Error(`claim start answered ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.code as string;
}

/** POST /account/api/link exactly as the page does (signed CSRF, same-origin). */
export async function link(c: APIRequestContext, code: string, password: string): Promise<APIResponse> {
  return post(c, "/account/api/link", { code, password, confirm: true });
}
export { claimsOf };

/** A client that presents exactly this session cookie (a thief with a copied browser state), with a working CSRF cookie jar of its own. */
export async function clientWithSessionCookie(playwright: Playwright, value: string, ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: "http://localhost:3210",
    extraHTTPHeaders: { "x-forwarded-for": ip },
    storageState: { cookies: [{ name: "fdb_acct", value, domain: "localhost", path: "/account", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [] },
  });
}
