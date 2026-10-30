import { CONSENT_STORAGE_KEY, createConsentRecord } from "../src/lib/consent";

/**
 * Playwright `storageState` for the suites that are not about consent (account, account-e2e, zone-maps, atlas-cdn): the browser already holds a
 * REFUSAL of optional analytics, like a returning visitor who clicked "Reject optional", so the consent bar does not cover the page under test.
 * tests/e2e uses the equivalent `seedConsent` fixture; tests/e2e/consent*.spec.ts exercise the real first visit.
 */
export const consentStorageState = (origin: string) => ({
  cookies: [],
  origins: [{ origin, localStorage: [{ name: CONSENT_STORAGE_KEY, value: JSON.stringify(createConsentRecord(false)) }] }],
});
