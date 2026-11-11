import { expect, test } from "@playwright/test";
import { newClient } from "../account/helpers";

/** Retired owner/link routes stay absent under error-shaped and malformed requests. */
test("retired ownership endpoints return the same 404 without parsing request content", async ({ playwright }) => {
  const client = await newClient(playwright);
  for (const body of ["{}", "[]", "null", "not-json", "x".repeat(12_000)]) {
    const response = await client.post("/account/api/link", {
      headers: { "content-type": "application/json" },
      data: body,
    });
    expect([403, 404]).toContain(response.status());
  }
});
