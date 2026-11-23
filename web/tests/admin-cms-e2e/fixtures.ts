/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the servers under test are inspected structurally */
import { createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test as base, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";

const env = process.env as Record<string, string | undefined>;
export const GATEWAY = env.ACCOUNT_STACK_URL ?? "http://127.0.0.1:54321";
export const ANON = env.ACCOUNT_STACK_ANON_KEY ?? "";
export const DELIVERY = env.E2E_DELIVERY === "1";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function db(name = env.E2E_DB ?? "fdb_account_it"): Promise<pg.Client> {
  const c = new pg.Client({ host: env.E2E_PG_HOST, port: Number(env.E2E_PG_PORT), user: env.E2E_PG_USER, password: env.E2E_PG_PASSWORD, database: name });
  await c.connect();
  return c;
}

export function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, acc = 0; const bytes: number[] = [];
  for (const ch of secret.toUpperCase().replace(/=+$/, "")) {
    const n = alphabet.indexOf(ch); if (n < 0) throw Error("bad TOTP secret");
    acc = (acc << 5) | n; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  return String((h.readUInt32BE(h[h.length - 1]! & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}

export type RoleName = "Editor" | "Owner" | "Administrator" | "Moderator";
export interface Staff { tag: string; email: string; password: string; uid: string; role: RoleName | null; secret?: string; lastStep?: number }

/** A real GoTrue account (auto-confirmed in this stack), optionally made staff through the test-only SQL fixture. */
export async function newUser(tag: string): Promise<Staff> {
  const email = `${tag}-${randomBytes(4).toString("hex")}@example.test`;
  const password = `correct horse ${randomBytes(6).toString("hex")}`;
  const res = await fetch(`${GATEWAY}/auth/v1/signup`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const body: any = await res.json();
  if (res.status !== 200 || !body.user?.id) throw new Error(`signup answered ${res.status}: ${JSON.stringify(body)}`);
  return { tag, email, password, uid: body.user.id, role: null };
}

/** Staff provisioning stands in for the (not yet existing) staff-management API: it is test-only SQL run as the cluster superuser. */
export async function makeStaff(u: Staff, role: RoleName, o: { article?: string; expiresInSec?: number | null; approver?: string } = {}): Promise<void> {
  const c = await db();
  try {
    await c.query("insert into admin_private.staff_subjects(user_id,status) values($1,'active') on conflict do nothing", [u.uid]);
    const approver = o.approver ?? u.uid;
    const exp = role === "Owner" ? null : o.expiresInSec ?? 29 * 86400;
    await c.query(
      `insert into admin_private.role_assignments(user_id,role_name,policy_version_id,environment_scope,scope_kind,scope_id,starts_at,expires_at,review_due_at,status,approved_by,reason)
       values($1,$2,1,'staging',$3,$4,clock_timestamp()-interval '1 minute',case when $5::int is null then null else clock_timestamp()+($5::int||' seconds')::interval end,clock_timestamp()+interval '30 days','active',$6,'e2e fixture')`,
      [u.uid, role, o.article ? "article" : "global", o.article ?? null, exp, approver]);
    u.role = role;
  } finally { await c.end(); }
}

/** Full real sign-in through the website UI: password login, then TOTP (enrol once, then challenge) and the Admin hand-off. */
export async function enterAdmin(page: Page, u: Staff): Promise<void> {
  await page.goto("/account/login");
  // An account session may already exist in this browser (re-verification after the TOTP freshness window): the login page then redirects to /account.
  if (new URL(page.url()).pathname !== "/account") {
    await page.getByLabel("Email address").fill(u.email);
    await page.getByLabel("Password").fill(u.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/account(\?|$)/);
  }
  const panel = page.getByRole("region", { name: "Admin authentication" });
  await expect(panel).toBeVisible();
  const enrolledBefore = !!u.secret;
  if (!u.secret) {
    await panel.getByRole("button", { name: "Enroll TOTP" }).click();
    const code = panel.locator("code");
    await expect(code).toBeVisible();
    u.secret = (await code.textContent())!.trim();
  }
  // For an already enrolled account the panel hides "Enroll TOTP" only once its factor list has loaded; clicking earlier would find no factor.
  if (enrolledBefore) await expect(panel.getByRole("button", { name: "Enroll TOTP" })).toBeHidden();
  await panel.getByRole("button", { name: "Request TOTP challenge" }).click();
  await expect(panel.getByLabel("Six-digit code")).toBeVisible();
  // A code can be used once per 30 s step: wait for a fresh step when this secret already verified in the current one.
  const step = (): number => Math.floor(Date.now() / 30000);
  if (u.lastStep === step()) await sleep(30000 - (Date.now() % 30000) + 500);
  u.lastStep = step();
  await panel.getByLabel("Six-digit code").fill(totp(u.secret));
  await panel.getByRole("button", { name: "Verify and enter Admin" }).click();
  await page.waitForURL(/\/admin(\/|$|\?)/);
}

export async function newStaffPage(ctx: BrowserContext, u: Staff): Promise<Page> {
  const page = await ctx.newPage();
  await enterAdmin(page, u);
  return page;
}

/** Real TOTP freshness: GoTrue records the verification time in auth.mfa_amr_claims, the database refuses anything older than 15 minutes. */
export async function ageTotp(sessionOfUser: string, minutes: number): Promise<void> {
  const c = await db();
  try {
    await c.query("update auth.mfa_amr_claims set updated_at=updated_at-($2||' minutes')::interval where session_id in (select id from auth.sessions where user_id=$1)", [sessionOfUser, String(minutes)]);
  } finally { await c.end(); }
}

/** One pass of the REAL ADM-03C one-shot delivery worker (a separate process with its own database roles). Returns its JSON report. */
export function runWorker(): { candidates: number; delivered: number; cancelled: number; retried: number; compensated: number } {
  if (!DELIVERY) throw new Error("the delivery ledger/worker is not part of this stack (start up.sh with FDB_ADM03C_DIR)");
  const r = spawnSync(process.execPath, [resolve(env.E2E_STACK_DIR!, "cms-delivery/src/once.mjs")], {
    cwd: resolve(env.E2E_STACK_DIR!, "repo"),
    env: {
      PATH: process.env.PATH ?? "", FDB_CMS_DISPOSABLE: "1", FOREVERDB_DEPLOYMENT: "local", FDB_CMS_TEST_SET_ROLE: "1",
      FDB_CMS_PRIVATE_URL: `postgres://${env.E2E_PG_USER}:${env.E2E_PG_PASSWORD}@${env.E2E_PG_HOST}:${env.E2E_PG_PORT}/${env.E2E_DB}`,
      FDB_CMS_PUBLIC_URL: `postgres://${env.E2E_PG_USER}:${env.E2E_PG_PASSWORD}@${env.E2E_PG_HOST}:${env.E2E_PG_PORT}/${env.E2E_PUBDB}`,
      FDB_CMS_ASSET_ROOT: resolve(env.E2E_STACK_DIR!, "repo/web/public"),
    } as unknown as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`worker exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

export const uniqueSlug = (p = "e2e"): string => `${p}-${randomBytes(4).toString("hex")}`;
export const BODY = "First paragraph of a **real** article.\n\n- point one\n- point two\n\n[A safe link](https://example.com/page)";

/** Creates a draft through the real editor UI and returns its detail-page URL. */
export async function createDraft(page: Page, o: { slug?: string; title?: string; highlighted?: boolean; body?: string } = {}): Promise<{ slug: string; title: string; url: string }> {
  const slug = o.slug ?? uniqueSlug();
  const title = o.title ?? `E2E article ${slug}`;
  await page.goto("/admin/articles/new");
  await page.getByLabel("Slug (permanent)", { exact: true }).fill(slug);
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Summary", { exact: true }).fill("A summary that is certainly long enough to pass.");
  await page.getByLabel("Markdown", { exact: true }).fill(o.body ?? BODY);
  if (o.highlighted) await page.getByLabel(/^Featured/).check();
  await page.getByTestId("save-draft").click();
  await page.waitForURL(/\/admin\/articles\/[0-9a-f-]{36}$/);
  return { slug, title, url: new URL(page.url()).pathname };
}

/** The staff member's current AAL2 session id (real GoTrue), for the revocation tests. */
export async function sessionIdsOf(uid: string): Promise<string[]> {
  const c = await db();
  try { return (await c.query("select id from auth.sessions where user_id=$1", [uid])).rows.map((r) => r.id as string); } finally { await c.end(); }
}

/** A fresh API-level AAL2 session at real GoTrue (password grant + TOTP). Used only to talk to PostgREST directly in the negative tests. */
export async function aal2Token(u: Staff): Promise<string> {
  const post = async (path: string, body: unknown, token?: string): Promise<any> => {
    const r = await fetch(`${GATEWAY}/auth/v1${path}`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const login = await post("/token?grant_type=password", { email: u.email, password: u.password });
  if (login.status !== 200) throw new Error(`password grant answered ${login.status}`);
  let token = login.body.access_token as string;
  let factorId: string;
  if (!u.secret) {
    const enrol = await post("/factors", { factor_type: "totp", friendly_name: "api", issuer: "AzerDex" }, token);
    factorId = enrol.body.id; u.secret = enrol.body.totp.secret;
    const ch = await post(`/factors/${factorId}/challenge`, {}, token);
    if (u.lastStep === Math.floor(Date.now() / 30000)) await sleep(30000 - (Date.now() % 30000) + 500);
    u.lastStep = Math.floor(Date.now() / 30000);
    const v = await post(`/factors/${factorId}/verify`, { challenge_id: ch.body.id, code: totp(u.secret!) }, token);
    if (v.status !== 200) throw new Error(`verify answered ${v.status}`);
    return v.body.access_token;
  }
  const factors = await fetch(`${GATEWAY}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<any>);
  factorId = factors.factors.find((f: any) => f.status === "verified").id;
  const ch = await post(`/factors/${factorId}/challenge`, {}, token);
  if (u.lastStep === Math.floor(Date.now() / 30000)) await sleep(30000 - (Date.now() % 30000) + 500);
  u.lastStep = Math.floor(Date.now() / 30000);
  const v = await post(`/factors/${factorId}/verify`, { challenge_id: ch.body.id, code: totp(u.secret) }, token);
  if (v.status !== 200) throw new Error(`verify answered ${v.status}`);
  token = v.body.access_token;
  return token;
}

export async function rest(token: string | null, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`${GATEWAY}/rest/v1/${path}`, { method: init.method ?? "GET", headers: { apikey: ANON, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const t = await r.text();
  let body: any = t; try { body = t ? JSON.parse(t) : null; } catch { /* keep text */ }
  return { status: r.status, body };
}

/** Reads one article's CMS state straight from the private tables as the superuser (verification only, never the UI under test). */
export async function articleRow(slug: string): Promise<any> {
  const c = await db();
  try { return (await c.query("select * from editorial_private.articles where slug=$1", [slug])).rows[0]; } finally { await c.end(); }
}
export async function revisionCount(slug: string): Promise<number> {
  const c = await db();
  try { return (await c.query("select count(*)::int n from editorial_private.revisions r join editorial_private.articles a using(article_id) where a.slug=$1", [slug])).rows[0].n; } finally { await c.end(); }
}

// The website keeps its PER-IP budgets at the production defaults (they are part of what is tested), and every test browser would otherwise share one
// address. Each browser context therefore presents its own forwarded address, exactly like distinct visitors behind the trusted proxy header.
let ipSeq = Math.floor(Math.random() * 200);
const uniqueIp = (): string => `198.51.100.${(++ipSeq % 250) + 1}`;
export const test = base.extend({
  contextOptions: async ({ contextOptions }, provide) => { await provide({ ...contextOptions, extraHTTPHeaders: { ...(contextOptions.extraHTTPHeaders ?? {}), "x-forwarded-for": uniqueIp() } }); },
});
export { expect };
export const newCtx = (browser: Browser): Promise<BrowserContext> => browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": uniqueIp() } });
