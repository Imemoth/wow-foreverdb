import { test as base, expect } from "@playwright/test";

let n = 10;
/** Each test is a distinct client (unique forwarded IP) so budgets do not bleed between tests. */
export const test = base.extend({
  context: async ({ context }, provide) => {
    n += 1;
    await context.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${n % 250}` });
    await provide(context);
  },
});
export { expect };
