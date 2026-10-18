import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { browserPairingWebAvailable } from "@/lib/account/pairing-gate";
import { PAIRING_COOKIE_TTL_SEC, clearPairingCookie, isCanonicalPairingId, mintPairingCookie, setPairingCookie } from "@/lib/account/pairing-cookie";
import { failure } from "@/lib/account/http";
import { API_CSP, BASE_SECURITY_HEADERS, HSTS, SENSITIVE_PAGE_REFERRER_POLICY, buildPageCsp, deploymentHeaders, type DeploymentKindName } from "@/lib/security/headers";
import { isSameOriginJson, isSameOriginRequest } from "@/lib/security/challenge";
import { clientIp, hashIp, newSessionId, verifyPass } from "@/lib/security/identity";
import {
  MemoryStore,
  UpstashStore,
  checkRateLimit,
  checkStrictLimit,
  classifyRequest,
  isAccountApiPath,
  isNativePairingRequest,
  isAccountPath,
  isStrictRule,
  loadRules,
  validSessionId,
  type CounterStore,
} from "@/lib/security/rate-limit";

/**
 * Edge of the application (Next.js 16 "proxy", formerly middleware):
 *  1. per-request CSP nonce for HTML,
 *  2. distributed rate limiting + progressive challenge for data routes,
 *  3. anonymous session cookie used ONLY as an extra rate-limit dimension.
 * Runs before route handlers and before any public data access.
 */

let store: CounterStore | null = null;
function counterStore(): CounterStore {
  if (store) return store;
  const env = serverEnv();
  store = env.RATE_LIMIT_BACKEND === "upstash"
    ? new UpstashStore(env.UPSTASH_REDIS_REST_URL!, env.UPSTASH_REDIS_REST_TOKEN!)
    : new MemoryStore();
  return store;
}

const rules = loadRules(process.env.RATE_LIMITS_JSON);

function log(event: string, data: Record<string, unknown>) {
  // Privacy-safe operational telemetry: hashed client, route class, no query strings.
  console.info(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function tooMany(isApi: boolean, retryAfter: number, reason: string, https: boolean, kind: DeploymentKindName, extra: Record<string, string> = {}): NextResponse {
  const headers: Record<string, string> = {
    ...BASE_SECURITY_HEADERS,
    ...deploymentHeaders(kind),
    "Retry-After": String(retryAfter),
    "Cache-Control": "no-store",
    ...extra,
  };
  if (https) headers["Strict-Transport-Security"] = HSTS;
  if (isApi) {
    return NextResponse.json(
      { error: reason, retryAfterSeconds: retryAfter },
      { status: 429, headers: { ...headers, "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" } },
    );
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slow down - ForeverDB</title><meta name="robots" content="noindex"></head><body style="background:#0e1116;color:#e8e2d4;font:16px system-ui,sans-serif;padding:3rem;max-width:40rem;margin:auto"><h1>Too many requests</h1><p>You are browsing the database faster than our fair-use limit allows. Please wait about ${retryAfter} seconds and try again.</p>${reason === "challenge_required" ? '<p><a style="color:#e0b45b" href="/verify">Verify you are human</a> to continue at a higher rate.</p>' : ""}</body></html>`;
  return new NextResponse(html, {
    status: 429,
    headers: {
      ...headers,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

export async function proxy(request: NextRequest) {
  const env = serverEnv();
  const { pathname } = request.nextUrl;
  const ruleName = classifyRequest(pathname, request.method);
  const nativePairing = ruleName === "account_pairing_native";
  const nativeFailure = (status: number, error: string, headers: Record<string, string> = {}) => failure(status, error, {}, {
    ...deploymentHeaders(env.FOREVERDB_DEPLOYMENT),
    ...(env.SITE_URL.startsWith("https://") ? { "Strict-Transport-Security": HSTS } : {}),
    ...headers,
  });
  // Source-off is an ingress refusal: do not read client metadata/cookies or contact the limiter first.
  if (nativePairing && (!env.accountAuth || !browserPairingWebAvailable({ cfg: env.accountAuth, env }))) {
    return nativeFailure(404, "not_found");
  }
  const pairingIntake = request.method === "GET" && pathname === "/account/device-pair" && request.nextUrl.searchParams.has("request");
  const pairingConfig = env.accountAuth;
  if (pairingIntake && pairingConfig && browserPairingWebAvailable({ cfg: pairingConfig, env })) {
    const https = env.SITE_URL.startsWith("https://");
    const headers = {
      ...BASE_SECURITY_HEADERS,
      ...deploymentHeaders(env.FOREVERDB_DEPLOYMENT),
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      Vary: "Cookie",
      ...(https ? { "Strict-Transport-Security": HSTS } : {}),
    };
    const response = NextResponse.redirect(new URL("/account/device-pair", env.SITE_URL), { status: 303, headers });
    const locators = request.nextUrl.searchParams.getAll("request");
    if (locators.length === 1 && isCanonicalPairingId(locators[0]!)) {
      setPairingCookie(response.headers, https, await mintPairingCookie(pairingConfig.csrfSecret, locators[0]!), PAIRING_COOKIE_TTL_SEC);
    } else {
      clearPairingCookie(response.headers, https);
    }
    return response;
  }
  const isAccountApi = isAccountApiPath(pathname);
  const isApi = pathname.startsWith("/api/") || isAccountApi;
  // Account System V1: /account/** (pages and /account/api/*) is private. It is never cached, never indexed (in every
  // deployment, production included), never leaks an account path/query in Referer, and never receives the anonymous rate-limit cookie.
  const isAccount = isAccountPath(pathname);
  const accountHeaders: Record<string, string> = isAccount
    ? {
        "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow",
        "Referrer-Policy": isAccountApi ? "no-referrer" : SENSITIVE_PAGE_REFERRER_POLICY,
        // API responses carry no markup; pages get the nonce CSP below.
        ...(isAccountApi ? { "Content-Security-Policy": API_CSP } : {}),
      }
    : {};
  const https = env.SITE_URL.startsWith("https://");
  const kind = env.FOREVERDB_DEPLOYMENT;
  const stamp = deploymentHeaders(kind);
  // The __Host- prefix (and Secure) follows the real origin: never a Secure-less cookie on an https site.
  const sidCookie = https ? "__Host-fdb_sid" : "fdb_sid";

  const ipHash = hashIp(clientIp(request.headers, env.TRUSTED_IP_HEADER), env.RATE_LIMIT_SALT);
  const sessionId = validSessionId(request.cookies.get(sidCookie)?.value);

  if (ruleName && isStrictRule(ruleName)) {
    // Endpoints with costly side effects (outbound calls to Cloudflare Siteverify or to Supabase Auth). Nothing below
    // may reach the route handler without first passing the origin pre-check and the strict per-IP + global budget.
    // api_challenge applies only once Turnstile is configured (the route answers 404 for free otherwise); the account
    // rules always apply (a disabled account area answers 404 after the handler, which costs nothing outbound).
    const account = ruleName !== "api_challenge";
    if (account || (env.TURNSTILE_SECRET_KEY && env.CHALLENGE_COOKIE_SECRET)) {
      // Cross-site POSTs are refused BEFORE counting so a hostile page cannot burn a victim's budget from their browser.
      const sameOrigin = ruleName === "account_pairing_native"
        ? isNativePairingRequest(request.headers, env.SITE_URL)
        : account
        ? request.method !== "POST" || isSameOriginRequest(request.headers, env.SITE_URL)
        : isSameOriginJson(request.headers, env.SITE_URL);
      if (!sameOrigin) {
        if (nativePairing) return nativeFailure(403, "forbidden");
        return NextResponse.json({ error: "forbidden" }, {
          status: 403,
          headers: { ...BASE_SECURITY_HEADERS, ...stamp, ...accountHeaders, ...(https ? { "Strict-Transport-Security": HSTS } : {}), "Cache-Control": account ? "private, no-store" : "no-store", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" },
        });
      }
      try {
        // Identity: trusted-header IP hash only. The session cookie is client-controlled and deliberately NOT part of this decision.
        const decision = await checkStrictLimit(counterStore(), ruleName, rules[ruleName], ipHash);
        if (!decision.allowed) {
          log("rate_limited", { rule: ruleName, reason: decision.reason, client: ipHash.slice(0, 8) });
          if (nativePairing) return nativeFailure(429, "rate_limited", { "Retry-After": String(Math.min(3600, Math.max(1, decision.retryAfterSec))) });
          return tooMany(true, decision.retryAfterSec, decision.reason, https, kind, accountHeaders);
        }
      } catch (e) {
        // FAIL CLOSED: without a working limiter we must not expose the outbound call. Data routes are unaffected.
        log("rate_limit_store_error", { rule: ruleName, error: e instanceof Error ? e.message : "unknown" });
        if (nativePairing) return nativeFailure(503, "temporarily_unavailable", { "Retry-After": "30" });
        return NextResponse.json({ error: "temporarily_unavailable" }, {
          status: 503, headers: { ...BASE_SECURITY_HEADERS, ...stamp, ...accountHeaders, ...(https ? { "Strict-Transport-Security": HSTS } : {}), "Retry-After": "30", "Cache-Control": account ? "private, no-store" : "no-store" },
        });
      }
    }
  } else if (ruleName) {
    try {
      const decision = await checkRateLimit(counterStore(), ruleName, rules[ruleName], {
        ipHash,
        sessionId,
        challengePassed: verifyPass(request.cookies.get("fdb_pass")?.value, ipHash, env.CHALLENGE_COOKIE_SECRET),
      }, { challengeEnabled: Boolean(env.TURNSTILE_SECRET_KEY) });
      if (!decision.allowed) {
        log("rate_limited", { rule: ruleName, reason: decision.reason, client: ipHash.slice(0, 8) });
        return tooMany(isApi, decision.retryAfterSec, decision.reason, https, kind);
      }
    } catch (e) {
      // Store outage: APIs fail closed; HTML pages fail open (still behind WAF,
      // DB timeouts and caches). Documented in docs/web/api-contract.md.
      log("rate_limit_store_error", { rule: ruleName, error: e instanceof Error ? e.message : "unknown" });
      if (isApi) {
        return NextResponse.json({ error: "temporarily_unavailable" }, {
          status: 503, headers: { ...BASE_SECURITY_HEADERS, ...stamp, ...(https ? { "Strict-Transport-Security": HSTS } : {}), "Retry-After": "30", "Cache-Control": "no-store" },
        });
      }
    }
  }

  if (isApi) {
    const res = NextResponse.next();
    for (const [k, v] of Object.entries({ ...BASE_SECURITY_HEADERS, ...stamp, ...accountHeaders })) res.headers.set(k, v);
    if (https) res.headers.set("Strict-Transport-Security", HSTS);
    return res;
  }

  // HTML: nonce-based CSP. Pages are dynamically rendered and never shared-cached.
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = buildPageCsp(nonce, {
    dev: process.env.NODE_ENV !== "production",
    turnstile: Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
    https,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  for (const [k, v] of Object.entries({ ...BASE_SECURITY_HEADERS, ...stamp, ...accountHeaders })) res.headers.set(k, v);
  if (https) res.headers.set("Strict-Transport-Security", HSTS);
  // The anonymous rate-limit cookie is for public browsing only: account pages neither receive nor issue it.
  if (!isAccount && !sessionId && request.method === "GET") {
    res.cookies.set(sidCookie, newSessionId(), {
      httpOnly: true, secure: https, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30,
    });
  }
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|fonts/|favicon.ico|icon.svg|robots.txt|sitemap.xml|og/).*)",
    },
  ],
};
