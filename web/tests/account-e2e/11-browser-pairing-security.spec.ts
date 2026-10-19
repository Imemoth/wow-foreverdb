import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import type pg from "pg";
import { admin, anonymous, resetBudgets } from "./stack";
import { cookieOf, json, makePairingDue, nativePairingPost, newClient, openPairing, pairingDecision, pairingMaterial, post, webUser } from "./world";

test.use({ trace: "off" });

let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });
test.beforeEach(async () => { await resetBudgets(db); });
const row = async (id: string) => (await db.query("select to_jsonb(p) row from private.device_pairings p where id=$1", [id])).rows[0]?.row;

test("locator intake is selection-only, cleans the URL and refuses forged locator cookies", async ({ playwright }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const account = await webUser(playwright, "pairLocator");
  const before = await row(p.pairingId);
  const intake = await account.c.get(`/account/device-pair?request=${p.pairingId}`, { maxRedirects: 0 });
  expect(intake.status()).toBe(303);
  expect(intake.headers().location).toBe("/account/device-pair");
  expect(intake.headers()["referrer-policy"]).toBe("no-referrer");
  expect(await row(p.pairingId)).toEqual(before);
  const pairCookie = await cookieOf(account.c, "fdb_pair");
  expect(pairCookie).toBeTruthy();
  const state = await account.c.storageState();
  const forged = state.cookies.map((c) => c.name === "fdb_pair" ? { ...c, value: `${c.value.slice(0, -1)}${c.value.endsWith("A") ? "B" : "A"}` } : c);
  const attacker = await playwright.request.newContext({ baseURL: "http://localhost:3210", storageState: { cookies: forged, origins: [] } });
  const page = await attacker.get("/account/device-pair");
  expect(page.status()).toBe(200);
  expect(await page.text()).toContain("No valid pairing request");
  expect(await row(p.pairingId)).toEqual(before);
});

test("decision mutation requires same-origin JSON, CSRF, exact locator and rendered-session binding", async ({ playwright }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const account = await webUser(playwright, "pairGuards");
  const rendered = await openPairing(account.c, p.pairingId);
  const before = await row(p.pairingId);
  const attempts = [
    pairingDecision(account.c, "approve", p.pairingId, rendered.pageBinding, { csrf: "none" }),
    pairingDecision(account.c, "approve", p.pairingId, rendered.pageBinding, { origin: "https://evil.invalid", fetchSite: "cross-site" }),
    account.c.post("/account/api/device-pair/approve", { headers: { origin: "http://localhost:3210", "sec-fetch-site": "same-origin", "content-type": "text/plain" }, data: "{}" }),
    pairingDecision(account.c, "approve", p.pairingId, "fdbpg1_" + "A".repeat(43)),
  ];
  for (const pending of attempts) expect((await pending).status()).toBeGreaterThanOrEqual(400);
  expect(await row(p.pairingId)).toEqual(before);
});

test("account switching and stale-tab locators cannot authorize an old rendered decision", async ({ playwright }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const oldPair = pairingMaterial();
  const newPair = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, oldPair)).status()).toBe(200);
  expect((await nativePairingPost(native, "start", initiator, newPair)).status()).toBe(409); // one live request per installation identity
  const first = await webUser(playwright, "pairSwitchA");
  const second = await webUser(playwright, "pairSwitchB");
  const rendered = await openPairing(first.c, oldPair.pairingId);
  expect((await post(first.c, "/account/api/login", { email: second.email, password: second.password })).status()).toBe(200);
  const switched = await pairingDecision(first.c, "approve", oldPair.pairingId, rendered.pageBinding);
  expect(switched.status()).toBe(409);
  expect(await json(switched)).toEqual({ ok: false, error: "account_changed" });
  expect((await row(oldPair.pairingId)).status).toBe("pending");
});

test("a newer locator makes an older tab inert without clearing the newer request", async ({ playwright }) => {
  const firstInitiator = await anonymous();
  const secondInitiator = await anonymous();
  const native = await newClient(playwright);
  const first = pairingMaterial();
  const second = pairingMaterial();
  expect((await nativePairingPost(native, "start", firstInitiator, first)).status()).toBe(200);
  expect((await nativePairingPost(native, "start", secondInitiator, second)).status()).toBe(200);
  const account = await webUser(playwright, "pairStaleTab");
  const oldTab = await openPairing(account.c, first.pairingId);
  const currentTab = await openPairing(account.c, second.pairingId);
  const stale = await pairingDecision(account.c, "approve", first.pairingId, oldTab.pageBinding);
  expect(stale.status()).toBe(409);
  expect(await json(stale)).toEqual({ ok: false, error: "pairing_not_available" });
  expect((await row(first.pairingId)).status).toBe("pending");
  expect((await pairingDecision(account.c, "approve", second.pairingId, currentTab.pageBinding)).status()).toBe(200);
  expect((await row(second.pairingId)).status).toBe("approved");
});

test("the signed locator survives the fixed login continuation and never appears in the login URL", async ({ playwright }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const visitor = await newClient(playwright);
  const landing = await visitor.get(`/account/device-pair?request=${p.pairingId}`);
  expect(landing.url()).toContain("/account/login?next=%2Faccount%2Fdevice-pair");
  expect(landing.url()).not.toContain(p.pairingId);
  const account = await webUser(playwright, "pairContinuation");
  const login = await post(visitor, "/account/api/login", { email: account.email, password: account.password });
  expect(login.status()).toBe(200);
  const page = await visitor.get("/account/device-pair");
  const html = await page.text();
  expect(page.status()).toBe(200);
  expect(html).toContain(account.email);
  expect(html).toContain(p.computerName);
  expect((await row(p.pairingId)).status).toBe("pending");
});

test("native boundary accepts absent browser metadata, rejects supplied foreign metadata, and never leaks proofs", async ({ playwright }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial();
  const foreign = await nativePairingPost(native, "start", initiator, p, { origin: "https://evil.invalid", "sec-fetch-site": "cross-site" });
  expect(foreign.status()).toBe(403);
  expect(await json(foreign)).toEqual({ ok: false, error: "forbidden" });
  const good = await nativePairingPost(native, "start", initiator, p);
  expect(good.status()).toBe(200);
  const text = await good.text();
  expect(text).not.toContain(p.pollSecret);
  expect(text).not.toContain(p.deviceCredential);
  expect(text).not.toContain(initiator.token);

  const account = await webUser(playwright, "pairNoLeak");
  const rendered = await openPairing(account.c, p.pairingId);
  expect(rendered.html).not.toContain(p.pollSecret);
  expect(rendered.html).not.toContain(p.deviceCredential);
  expect(rendered.html).not.toContain(initiator.uid);
  expect(rendered.html).not.toContain(p.installationId);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = resolve(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
  for (const file of walk(resolve(__dirname, "../../.next/static"))) {
    const js = readFileSync(file);
    expect(js.includes(Buffer.from(p.pollSecret)), file).toBe(false);
    expect(js.includes(Buffer.from(p.deviceCredential)), file).toBe(false);
  }
  await makePairingDue(db, p.pairingId);

  const stackDir = process.env.E2E_STACK_DIR;
  expect(stackDir).toBeTruthy();
  const logs = walk(stackDir!).filter((file) => file.endsWith(".log"));
  for (const file of logs) {
    const bytes = readFileSync(file);
    for (const secret of [p.pollSecret, p.deviceCredential, initiator.token]) {
      expect(bytes.includes(Buffer.from(secret)), `${file} contains a pairing proof`).toBe(false);
    }
  }
});
