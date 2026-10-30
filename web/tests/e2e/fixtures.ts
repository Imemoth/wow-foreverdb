import { test as base, expect } from "@playwright/test";
import { CONSENT_STORAGE_KEY, createConsentRecord } from "../../src/lib/consent";

let n = 10;
/**
 * Each test is a distinct client (unique forwarded IP) so budgets do not bleed between tests.
 *
 * `seedConsent` (default true) pre-records a REFUSAL of optional analytics, exactly what a returning visitor who clicked "Reject optional"
 * has, so the consent bar does not cover the page under test. The consent specs set it to false and exercise the real first visit.
 */
export const test = base.extend<{ seedConsent: boolean }>({
  seedConsent: [true, { option: true }],
  context: async ({ context, seedConsent }, provide) => {
    n += 1;
    await context.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${n % 250}` });
    if (seedConsent) {
      const raw = JSON.stringify(createConsentRecord(false));
      await context.addInitScript(
        ([key, value]) => {
          try {
            if (window.localStorage.getItem(key as string) === null) window.localStorage.setItem(key as string, value as string);
          } catch {
            /* storage unavailable: the bar simply shows */
          }
        },
        [CONSENT_STORAGE_KEY, raw],
      );
    }
    await provide(context);
  },
});
export { expect };
