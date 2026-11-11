import { expect, test } from "@playwright/test";
import { newClient, post } from "../account/helpers";
import { companionWithInstallation, webUser } from "./world";
import { admin, registeredSession, rpc } from "./stack";
import type pg from "pg";

/**
 * Guildbook privacy regression against real PostgreSQL and GoTrue: no Guildbook is persisted or exposed by website/API surfaces.
 */
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });

test("privacy: real uploads never persist Guildbook values and the website has no Guildbook route", async ({ playwright }) => {
  const account = await webUser(playwright, "privA");
  const anonymous = await companionWithInstallation({ guilds: 2, members: 5, tag: "AA" });
  const ids = [anonymous.installationId];
  expect((await db.query("select count(*)::int n from public.installation_guilds where installation_id = any($1)", [ids])).rows[0].n).toBe(0);
  expect((await db.query("select count(*)::int n from public.installation_guild_members where installation_id = any($1)", [ids])).rows[0].n).toBe(0);
  expect((await db.query("select count(*)::int n from public.installation_guild_professions where installation_id = any($1)", [ids])).rows[0].n).toBe(0);

  const visitor = await newClient(playwright);
  for (const client of [account.c, visitor]) {
    for (const [path, body] of [
      ["/account/api/guildbook/guilds", { installationId: anonymous.installationId }],
      ["/account/api/guildbook/members", { installationId: anonymous.installationId, guildKey: "Realm:Guild1", page: 0 }],
      ["/account/api/guildbook/members", { limit: 200 }],
    ] as const) expect([403, 404], path).toContain((await post(client, path, body)).status());
    expect((await client.get("/account/guildbook")).status()).toBe(404);
  }

  const registered = await registeredSession(account.email, account.password);
  for (const name of ["fdb_account_guildbook_guilds", "fdb_account_guildbook_members"]) {
    const result = await rpc(registered.token, name, { p_installation_id: anonymous.installationId, p_guild_key: "Realm:Guild1", p_limit: 200, p_offset: 0 });
    expect([401, 403, 404], name).toContain(result.status);
  }
});

test("the retired Guildbook routes ignore malformed and oversized request bodies", async ({ playwright }) => {
  const client = await newClient(playwright);
  for (const body of ["{}", "[]", "null", "not-json", "x".repeat(12_000)]) {
    for (const route of ["guildbook/guilds", "guildbook/members"]) {
      const response = await client.post(`/account/api/${route}`, {
        headers: { "content-type": "application/json" }, data: body,
      });
      expect([403, 404], route).toContain(response.status());
    }
  }
  expect((await client.get("/account/guildbook")).status()).toBe(404);
});
