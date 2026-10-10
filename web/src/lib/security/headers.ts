/** Security header builders shared by the proxy and route handlers. */

export function buildPageCsp(nonce: string, opts: { dev: boolean; turnstile: boolean; https: boolean }): string {
  const turnstile = opts.turnstile ? " https://challenges.cloudflare.com" : "";
  const directives = [
    "default-src 'self'",
    // 'strict-dynamic': only nonce-bearing scripts (and what they load) execute.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${turnstile}${opts.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${opts.dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${turnstile}`,
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
 */
export function deploymentHeaders(kind: DeploymentKindName): Record<string, string> {
  return {
    "X-ForeverDB-Deployment": kind,
    ...(kind === "production" ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
  };
}

export const PUBLIC_API_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
export const NO_STORE = "no-store";
