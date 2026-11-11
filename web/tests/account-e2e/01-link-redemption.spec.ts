import { expect, test } from "@playwright/test";
import { newClient } from "../account/helpers";
import { webUser } from "./world";

/** Regression coverage for the retired account-to-installation ownership surfaces. */
test("ownership and claim pages, APIs, and redirect targets are retired", async ({ playwright }) => {
  const visitor = await newClient(playwright);
  for (const path of ["/account/link", "/account/installations", "/account/api/link", "/account/api/installations"]) {
    const response = path.includes("/api/")
      ? await visitor.post(path, { headers: { "content-type": "application/json" }, data: "{}" })
      : await visitor.get(path);
    expect(path.includes("/api/") ? [403, 404] : [404], path).toContain(response.status());
  }

  const account = await webUser(playwright, "ownerless");
  expect((await account.c.get("/account/link")).status()).toBe(404);
  expect((await account.c.get("/account/installations")).status()).toBe(404);
});

test("website account login remains available and does not show installation ownership controls", async ({ playwright }) => {
  const account = await webUser(playwright, "ownerlessui");
  const page = await account.c.get("/account");
  expect(page.status()).toBe(200);
  const html = await page.text();
  expect(html).toContain("/account/devices");
  expect(html).not.toMatch(/choose who owns|claim this installation|transfer installation|connect this installation/i);
});
