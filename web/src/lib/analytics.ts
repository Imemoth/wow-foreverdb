/**
 * Only count visitors on our public AzerDex hosts, never generated Vercel
 * preview URLs, localhost or private/account flows. Vercel can then split
 * beta (Preview) from the eventual production site in its Analytics dashboard.
 *
 * Keep the original event shape so this is compatible with Analytics' pageview
 * and custom-event callbacks, and never pass query strings or fragments.
 */
const PUBLIC_HOSTS = new Set(["azerdex.com", "www.azerdex.com", "beta.azerdex.com"]);
const PRIVATE_PATH = /^\/(?:account|auth|verify|test-fixtures)(?:\/|$)/i;

export function filterAnalyticsEvent<T extends { url: string }>(event: T): T | null {
  let url: URL;
  try {
    url = new URL(event.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !PUBLIC_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (PRIVATE_PATH.test(url.pathname)) return null;

  // Search terms, auth tokens and other potential personal data never leave the browser.
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}
