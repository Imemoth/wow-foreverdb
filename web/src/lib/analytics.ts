/**
 * Only count visitors on our public AzerDex hosts, never generated Vercel
 * preview URLs, localhost or private/account flows. Vercel can then split
 * beta (Preview) from the eventual production site in its Analytics dashboard.
 *
 * Keep the original event shape so this is compatible with Analytics' pageview
 * and custom-event callbacks, and never pass query strings or fragments.
 */
import { currentAnalyticsConsent } from "@/lib/consent";

const PUBLIC_HOSTS = new Set(["azerdex.com", "www.azerdex.com", "beta.azerdex.com"]);
const PRIVATE_PATH = /^\/(?:account|auth|verify|test-fixtures)(?:\/|$)/i;

export function isPublicAnalyticsHost(hostname: string): boolean {
  return PUBLIC_HOSTS.has(hostname.toLowerCase());
}

export function filterAnalyticsEvent<T extends { url: string }>(event: T): T | null {
  let url: URL;
  try {
    url = new URL(event.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isPublicAnalyticsHost(url.hostname)) return null;
  if (PRIVATE_PATH.test(url.pathname)) return null;

  // Search terms, auth tokens and other potential personal data never leave the browser.
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}

/**
 * The `beforeSend` hook both Vercel scripts get. Consent is re-read from the visitor's own storage on EVERY event, so even if a script
 * were already loaded in this page, withdrawing consent (in this tab or another) cancels each following event: Vercel drops an event
 * when beforeSend returns null. The component that loads the scripts is also unmounted on withdrawal (components/consent/ConsentManager).
 */
export function consentedAnalyticsEvent<T extends { url: string }>(event: T, hasConsent: () => boolean = currentAnalyticsConsent): T | null {
  return hasConsent() ? filterAnalyticsEvent(event) : null;
}
