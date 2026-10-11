import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { APIRequestContext, APIResponse, PlaywrightWorkerArgs } from "@playwright/test";

type Playwright = PlaywrightWorkerArgs["playwright"];

/** Stack coordinates (real GoTrue behind the gateway shim, Mailpit). Same source as playwright.account.config.ts. */
function stackEnv(): Record<string, string> {
  const file = process.env.ACCOUNT_STACK_ENV_FILE ?? resolve(__dirname, "../auth-stack/.stack/env");
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
  } catch { /* env vars below */ }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string> };
}
const env = stackEnv();
export const AUTH_URL = env.ACCOUNT_STACK_URL ?? "http://127.0.0.1:54321";
export const ANON_KEY = env.ACCOUNT_STACK_ANON_KEY ?? "";
export const MAILPIT = env.MAILPIT_URL ?? "http://127.0.0.1:54324";
export const JWT_EXP_SEC = Number(env.STACK_JWT_EXP ?? 25);

export const SITES = {
  main: "http://localhost:3210",
  turnstile: "http://localhost:3211",
  demo: "http://localhost:3212",
  prodacct: "http://localhost:3213",
  hosted: "http://localhost:3214",
  httpsish: "http://localhost:3216", // its SITE_URL is https://localhost:3216 (cookie names / Secure flag on the wire)
} as const;
export const ORIGINS: Record<keyof typeof SITES, string> = {
  main: "http://localhost:3210", turnstile: "http://localhost:3211", demo: "https://foreverdb-demo.vercel.app",
  prodacct: "https://foreverdb-demo.vercel.app", hosted: "https://foreverdb-git-x.vercel.app", httpsish: "https://localhost:3216",
};

export const CSRF_SECRET = "acceptance-csrf-secret-0123456789abcdefghijklmnop"; // same value as playwright.account.config.ts
export const PASSWORD = "correct horse battery staple";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = Math.floor(Math.random() * 100000);
export const uniqueEmail = (tag = "u") => `${tag}-${Date.now().toString(36)}-${++seq}@example.test`;
/** Every client is a distinct visitor to the website's per-IP budgets. */
let ipSeq = Math.floor(Math.random() * 200);
export const uniqueIp = () => `198.51.100.${(++ipSeq % 250) + 1}`;

export async function newClient(playwright: Playwright, site: keyof typeof SITES = "main", ip = uniqueIp()): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: SITES[site], extraHTTPHeaders: { "x-forwarded-for": ip } });
}

export interface PostOptions {
  /** Origin header: undefined = the site's own origin, null = none, string = forged. */
  origin?: string | null;
  fetchSite?: string | null;
  csrf?: "auto" | "none" | string;
  contentType?: string;
  site?: keyof typeof SITES;
  raw?: string;
}

export async function csrfToken(c: APIRequestContext, site: keyof typeof SITES = "main"): Promise<string> {
  const r = await c.get("/account/api/csrf", { headers: { "sec-fetch-site": "same-origin" } });
  if (r.status() !== 200) throw new Error(`csrf endpoint answered ${r.status()}`);
  return ((await r.json()) as { token: string }).token;
}

/** A well-formed browser-like POST by default; every protection can be removed or forged per test. */
export async function post(c: APIRequestContext, path: string, body: unknown, o: PostOptions = {}): Promise<APIResponse> {
  const site = o.site ?? "main";
  const headers: Record<string, string> = { "content-type": o.contentType ?? "application/json" };
  const origin = o.origin === undefined ? ORIGINS[site] : o.origin;
  if (origin !== null) headers.origin = origin;
  const fs = o.fetchSite === undefined ? "same-origin" : o.fetchSite;
  if (fs !== null) headers["sec-fetch-site"] = fs;
  const token = o.csrf === "none" ? null : o.csrf && o.csrf !== "auto" ? o.csrf : await csrfToken(c, site);
  if (token) headers["x-fdb-csrf"] = token;
  return c.post(path, { headers, data: o.raw ?? JSON.stringify(body) });
}

export async function json<T = Record<string, unknown>>(r: APIResponse): Promise<T> {
  return (await r.json()) as T;
}

// ------------------------------------------------------------------------------------------------ mail
export interface Mail { id: string; subject: string; html: string; tokenHash: string; type: string; link: string }

export async function clearMail() {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
}

export async function waitForMail(to: string, subject: RegExp, timeoutMs = 15000): Promise<Mail> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages: { ID: string; Subject: string }[] };
    const hit = list.messages.find((m) => subject.test(m.Subject));
    if (hit) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as { HTML: string };
      const m = /href="([^"]*token_hash=([^&"]+)&(?:amp;)?type=(\w+))"/.exec(msg.HTML);
      if (!m) throw new Error(`mail ${hit.ID} has no confirmation link: ${msg.HTML.slice(0, 200)}`);
      return { id: hit.ID, subject: hit.Subject, html: msg.HTML, tokenHash: m[2]!, type: m[3]!, link: m[1]!.replace(/&amp;/g, "&") };
    }
    await sleep(250);
  }
  throw new Error(`no mail for ${to} matching ${subject} within ${timeoutMs} ms`);
}

export async function countMail(to: string): Promise<number> {
  const list = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages: unknown[] };
  return list.messages.length;
}

// ------------------------------------------------------------------------------------------------ direct Auth (a "Companion-style" client)
export async function authDirect(path: string, init: { method?: string; body?: unknown; bearer?: string } = {}) {
  const res = await fetch(`${AUTH_URL}${path}`, {
    method: init.method ?? "POST",
    headers: { apikey: ANON_KEY, "content-type": "application/json", ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* leave empty */ }
  return { status: res.status, data };
}

export function jwtClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Registers, confirms through the CAPTURED e-mail and signs in on the website. Returns the signed-in client. */
export async function signedInClient(playwright: Playwright, tag = "user", password = PASSWORD) {
  const email = uniqueEmail(tag);
  const c = await newClient(playwright);
  const reg = await post(c, "/account/api/register", { email, password });
  if (reg.status() !== 202) throw new Error(`register answered ${reg.status()}`);
  const mail = await waitForMail(email, /confirm/i);
  const conf = await post(c, "/account/api/confirm", { type: mail.type, token_hash: mail.tokenHash });
  if (conf.status() !== 200) throw new Error(`confirm answered ${conf.status()}`);
  return { c, email, password };
}

/** Set-Cookie headers of a response, parsed into attribute maps (name, value, flags). */
export function setCookies(r: APIResponse) {
  return r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => {
    const [pair, ...attrs] = h.value.split(";").map((s) => s.trim());
    const eq = pair!.indexOf("=");
    const flags: Record<string, string | true> = {};
    for (const a of attrs) { const i = a.indexOf("="); flags[(i < 0 ? a : a.slice(0, i)).toLowerCase()] = i < 0 ? true : a.slice(i + 1); }
    return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), flags, raw: h.value };
  });
}

// ------------------------------------------------------------------------------------------------ session cookie inspection / forging
// The website's session cookie is sealed (AES-256-GCM). The TEST knows the secret it started the server with, so it can open
// and re-seal the payload to forge states a browser could never reach (expired, foreign user). A thief without the secret cannot.
import { seal, unseal } from "../../src/lib/account/crypto";

export interface StoredSessionPayload { v: 1; k: "user" | "recovery"; uid: string; at: string; rt: string; ex: number; sid: string; sc: number; rf: number }
const aad = (name: string) => `fdb-acct-session-v1|${name}`;

export async function openSessionCookie(value: string, name = "fdb_acct"): Promise<StoredSessionPayload | null> {
  const plain = await unseal(CSRF_SECRET, value, aad(name));
  return plain ? (JSON.parse(plain) as StoredSessionPayload) : null;
}
export async function sealSessionCookie(p: StoredSessionPayload, name = "fdb_acct"): Promise<string> {
  return seal(CSRF_SECRET, JSON.stringify(p), aad(name));
}
export async function cookieOf(c: APIRequestContext, name = "fdb_acct") {
  return (await c.storageState()).cookies.find((x) => x.name === name);
}
/** A client that presents exactly this cookie (a thief with a copied cookie, or a forged state). */
export async function clientWithCookie(playwright: Playwright, value: string, site: keyof typeof SITES = "main", name = "fdb_acct") {
  return playwright.request.newContext({ baseURL: SITES[site], extraHTTPHeaders: { "x-forwarded-for": uniqueIp(), cookie: `${name}=${value}` } });
}
