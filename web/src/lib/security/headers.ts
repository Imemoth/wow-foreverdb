/** Security header builders shared by the proxy and route handlers. */

export function buildPageCsp(
  nonce: string,
  // assetOrigin: an allow-listed external map-asset origin (see lib/maps/asset-url.ts); only img-src and
  // connect-src (manifest fetch) gain it, and only for the routes whose caller passes it.
  opts: { dev: boolean; turnstile: boolean; https: boolean; assetOrigin?: string | null; heroImgOrigin?: string | null },
): string {
  const asset = opts.assetOrigin ? ` ${opts.assetOrigin}` : "";
  // CDN-served cinematic heroes: img-src only (no fetch), and nothing at all while the heroes are served same-origin.
  const hero = opts.heroImgOrigin && opts.heroImgOrigin !== opts.assetOrigin ? ` ${opts.heroImgOrigin}` : "";
  const turnstile = opts.turnstile ? " https://challenges.cloudflare.com" : "";
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic': only nonce-bearing scripts (and what they load) execute.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${turnstile}${opts.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${opts.dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    `img-src 'self' data:${asset}${hero}`,
    "font-src 'self'",
    `connect-src 'self'${turnstile}${asset}`,
    `frame-src${opts.turnstile ? turnstile : " 'none'"}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'none'",
  ];
  if (opts.https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Hides sensitive paths and queries while preserving a concrete Origin on same-origin native form POSTs.
 * `no-referrer` would serialize those non-CORS request origins as `null`, which our fail-closed CSRF guard rejects.
 */
export const SENSITIVE_PAGE_REFERRER_POLICY = "strict-origin" as const;

/** Headers applied to every response (see also next.config.ts). */
export const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
};

export const HSTS = "max-age=63072000; includeSubDomains";

export type DeploymentKindName = "local" | "preview" | "production";

/**
 * Headers that identify the ForeverDB deployment designation and keep every
 * non-production response out of search indexes (HTML, APIs and error responses).
 * `X-ForeverDB-Deployment` lets operators and tests tell a preview from a real
 * production release at the HTTP level, regardless of the Vercel target.
 *
 * `allowIndexing` lifts the blocking tag for exactly one narrowly-scoped response: the public-beta
 * homepage (see isPublicBetaHomepage in lib/seo.ts). Callers must have already verified all five
 * of its conditions themselves - this function does not check anything; every other call site
 * (APIs, error responses, every other page) must keep passing the default.
 */
export function deploymentHeaders(kind: DeploymentKindName, allowIndexing = false): Record<string, string> {
  return {
    "X-ForeverDB-Deployment": kind,
    ...(kind === "production" || allowIndexing ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
  };
}

export const PUBLIC_API_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
export const NO_STORE = "no-store";
