import { expect, test } from "@playwright/test";
import { webUser } from "./world";

/** The account UI retains authentication and device controls without installation ownership. */
test("the signed-in account home offers private account features without ownership UI", async ({ playwright }) => {
  const account = await webUser(playwright, "ownerlesshome");
  const response = await account.c.get("/account");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("/account/devices");
  expect(html).not.toMatch(/installation ownership|choose an owner|link this installation|transfer ownership/i);
});

test("device management stays account-authenticated and anonymous visitors are sent to sign-in", async ({ playwright }) => {
  const account = await webUser(playwright, "devicepage");
  const response = await account.c.get("/account/devices");
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("Your computers");

  const { newClient } = await import("../account/helpers");
  const visitor = await newClient(playwright);
  const redirected = await visitor.get("/account/devices", { maxRedirects: 0 });
  expect(redirected.status()).toBe(307);
  expect(redirected.headers().location).toContain("/account/login?next=%2Faccount%2Fdevices");
});
