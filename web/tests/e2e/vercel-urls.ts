/**
 * Exact URL classification for the consent specs (parsed URLs, exact hostnames and paths: never an unanchored regular expression on a URL).
 * "Insights script" = the Web Analytics script the Vercel component injects (same-origin in production builds, the CDN debug build in dev).
 */
const parse = (u: string | URL): URL | null => {
  try {
    return u instanceof URL ? u : new URL(u);
  } catch {
    return null;
  }
};

export const isInsightsScript = (u: string | URL): boolean => {
  const url = parse(u);
  if (!url) return false;
  return url.pathname === "/_vercel/insights/script.js" || (url.hostname === "va.vercel-scripts.com" && url.pathname === "/v1/script.debug.js");
};

/** Any request to a Vercel measurement endpoint (insights, speed-insights) or the Vercel script CDN. */
export const isVercelMeasurement = (u: string | URL): boolean => {
  const url = parse(u);
  if (!url) return false;
  return url.pathname.startsWith("/_vercel/") || url.hostname === "va.vercel-scripts.com";
};

export const isSpeedInsights = (u: string | URL): boolean => parse(u)?.pathname.startsWith("/_vercel/speed-insights/") === true;
