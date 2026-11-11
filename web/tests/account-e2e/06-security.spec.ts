import { expect, test } from "@playwright/test";
import { newClient } from "../account/helpers";
import { webUser } from "./world";

/** Private account responses remain scoped and the retired ownership surfaces do not return data. */
test("account pages remain private while ownership routes return no content", async ({ playwright }) => {
  const account = await webUser(playwright, "privateheaders");
  for (const path of ["/account", "/account/devices"]) {
    const response = await account.c.get(path);
    expect(response.status(), path).toBe(200);
    const headers = response.headers();
    expect(headers["cache-control"]).toBe("private, no-store");
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(headers["referrer-policy"]).toBe("strict-origin");
  }
  for (const path of ["/account/link", "/account/installations", "/account/api/link", "/account/api/installations"]) {
    const response = path.includes("/api/")
      ? await account.c.post(path, { headers: { "content-type": "application/json" }, data: "{}" })
      : await account.c.get(path);
    expect(path.includes("/api/") ? [403, 404] : [404], path).toContain(response.status());
    expect(await response.text()).not.toMatch(/installation_id|owner_user_id|guild_key|member_guid/i);
  }
});

test("an anonymous browser is redirected to sign in for devices and cannot reach ownership pages", async ({ playwright }) => {
  const visitor = await newClient(playwright);
  const devices = await visitor.get("/account/devices", { maxRedirects: 0 });
  expect(devices.status()).toBe(307);
  expect(devices.headers().location).toContain("/account/login?next=%2Faccount%2Fdevices");
  expect((await visitor.get("/account/link")).status()).toBe(404);
  expect((await visitor.get("/account/installations")).status()).toBe(404);
});
