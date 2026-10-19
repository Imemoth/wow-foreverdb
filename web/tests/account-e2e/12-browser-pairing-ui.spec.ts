import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Browser } from "@playwright/test";
import type pg from "pg";
import { admin, anonymous, resetBudgets, rpc } from "./stack";
import { makePairingDue, nativePairingPost, newClient, pairingMaterial, webUser } from "./world";

test.use({ trace: "off" });

let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });
test.beforeEach(async () => { await resetBudgets(db); });

async function browserFor(browser: Browser, user: Awaited<ReturnType<typeof webUser>>) {
  const state = await user.c.storageState();
  const context = await browser.newContext({ storageState: state, baseURL: "http://localhost:3210" });
  return { context, page: await context.newPage() };
}

test("real pending preview names the account/computer/suffix/expiry and keyboard approval never occurs on GET", async ({ playwright, browser }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial({ computerName: "UI Pairing PC" });
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const user = await webUser(playwright, "pairUi");
  const { context, page } = await browserFor(browser, user);
  await page.goto(`/account/device-pair?request=${p.pairingId}`);
  await expect(page).toHaveURL("http://localhost:3210/account/device-pair");
  await expect(page.getByRole("heading", { name: "Pair this computer" })).toBeVisible();
  await expect(page.getByText(user.email)).toBeVisible();
  await expect(page.getByText("UI Pairing PC")).toBeVisible();
  await expect(page.getByText(`…${p.installationId.slice(-6)}`)).toBeVisible();
  await expect(page.getByText(/UTC$/)).toBeVisible();
  expect((await db.query("select status from private.device_pairings where id=$1", [p.pairingId])).rows[0].status).toBe("pending");
  const approve = page.getByRole("button", { name: "Approve this computer" });
  const deny = page.getByRole("button", { name: "Deny request" });
  await expect(approve).toBeEnabled();
  await expect(deny).toBeEnabled();
  let releaseApproval!: () => void;
  const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });
  await page.route("**/account/api/device-pair/approve", async (route) => { await approvalGate; await route.continue(); });
  await approve.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Pair this computer" })).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Approving…" })).toBeDisabled();
  await expect(deny).toBeDisabled();
  releaseApproval();
  await expect(page.getByRole("status")).toContainText("Approved");
  expect((await db.query("select status from private.device_pairings where id=$1", [p.pairingId])).rows[0].status).toBe("approved");
  expect((await new AxeBuilder({ page: page as never }).analyze()).violations).toEqual([]);
  await context.close();
});

test("approved initial state exposes only denial, terminal preview is inert, and layouts remain usable", async ({ playwright, browser }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial({ computerName: "Responsive PC" });
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const user = await webUser(playwright, "pairUiApproved");
  expect((await rpc(user.accessToken, "fdb_account_device_pair_approve", { p_pairing_id: p.pairingId })).body).toEqual({ ok: true, state: "approved" });
  const { context, page } = await browserFor(browser, user);
  await page.setViewportSize({ width: 375, height: 780 });
  await page.goto(`/account/device-pair?request=${p.pairingId}`);
  await expect(page.getByRole("button", { name: "Deny this approved request" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve/ })).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("button", { name: "Deny this approved request" })).toBeVisible();
  await page.getByRole("button", { name: "Deny this approved request" }).click();
  await expect(page.getByRole("status")).toContainText("Denied");
  await page.reload();
  await expect(page.getByText("No valid pairing request")).toBeVisible();
  expect((await db.query("select status from private.device_pairings where id=$1", [p.pairingId])).rows[0].status).toBe("denied");
  await context.close();
});

test("expired terminal preview renders a static announced state without decision controls or secrets", async ({ playwright, browser }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const user = await webUser(playwright, "pairUiExpired");
  await db.query("update private.device_pairings set created_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 second' where id=$1", [p.pairingId]);
  const { context, page } = await browserFor(browser, user);
  await page.goto(`/account/device-pair?request=${p.pairingId}`);
  await expect(page.getByRole("status")).toContainText("expired");
  await expect(page.getByRole("button", { name: /Approve|Deny/ })).toHaveCount(0);
  expect(await page.content()).not.toContain(p.pollSecret);
  expect(await page.content()).not.toContain(p.deviceCredential);
  await makePairingDue(db, p.pairingId);
  await context.close();
});

test("an unknown network outcome is announced and freezes both decisions pending reload", async ({ playwright, browser }) => {
  const initiator = await anonymous();
  const native = await newClient(playwright);
  const p = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, p)).status()).toBe(200);
  const user = await webUser(playwright, "pairUiNetwork");
  const { context, page } = await browserFor(browser, user);
  await page.route("**/account/api/device-pair/approve", (route) => route.abort("connectionfailed"));
  await page.goto(`/account/device-pair?request=${p.pairingId}`);
  await page.getByRole("button", { name: "Approve this computer" }).click();
  const alert = page.locator('[role="alert"]').filter({ hasText: "We could not confirm" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/reload|confirm/i);
  await expect(page.getByRole("button", { name: "Approve this computer" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Deny request" })).toBeDisabled();
  expect((await db.query("select status from private.device_pairings where id=$1", [p.pairingId])).rows[0].status).toBe("pending");
  await context.close();
});
