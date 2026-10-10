import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { BASE_SECURITY_HEADERS, HSTS, buildPageCsp, deploymentHeaders, type DeploymentKindName } from "@/lib/security/headers";
import { isSameOriginJson } from "@/lib/security/challenge";
import { clientIp, hashIp, newSessionId, verifyPass } from "@/lib/security/identity";
import {
  MemoryStore,
  UpstashStore,
  checkRateLimit,
  checkStrictLimit,
  classifyRequest,
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

function tooMany(isApi: boolean, retryAfter: number, reason: string, https: boolean, kind: DeploymentKindName): NextResponse {
  const headers: Record<string, string> = {
    ...BASE_SECURITY_HEADERS,
    ...deploymentHeaders(kind),
    "Retry-After": String(retryAfter),
    "Cache-Control": "no-store",
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
  const isApi = pathname.startsWith("/api/");
  const https = env.SITE_URL.startsWith("https://");
  const kind = env.FOREVERDB_DEPLOYMENT;
  const stamp = deploymentHeaders(kind);
  // The __Host- prefix (and Secure) follows the real origin: never a Secure-less cookie on an https site.
  const sidCookie = https ? "__Host-fdb_sid" : "fdb_sid";

  const ipHash = hashIp(clientIp(request.headers, env.TRUSTED_IP_HEADER), env.RATE_LIMIT_SALT);
  const sessionId = validSessionId(request.cookies.get(sidCookie)?.value);

  const ruleName = classifyRequest(pathname, request.method);
  if (ruleName === "api_challenge") {
    // Outbound-call endpoint (Cloudflare Siteverify). Nothing below may reach
    // the route handler without first passing the origin pre-check and the
    // strict per-IP + global budget. Not applicable until Turnstile is
    // configured (the route answers 404 for free).
    if (env.TURNSTILE_SECRET_KEY && env.CHALLENGE_COOKIE_SECRET) {
      // Cross-site POSTs are refused BEFORE counting so a hostile page cannot
      // burn a victim's budget from their browser.
      if (!isSameOriginJson(request.headers, env.SITE_URL)) {
        return NextResponse.json({ error: "forbidden" }, {
          status: 403,
          headers: { ...BASE_SECURITY_HEADERS, ...stamp, ...(https ? { "Strict-Transport-Security": HSTS } : {}), "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" },
        });
      }
      try {
        // Identity: trusted-header IP hash only. The session cookie is
        // client-controlled and deliberately NOT part of this decision.
        const decision = await checkStrictLimit(counterStore(), ruleName, rules[ruleName], ipHash);
        if (!decision.allowed) {
          log("rate_limited", { rule: ruleName, reason: decision.reason, client: ipHash.slice(0, 8) });
          return tooMany(true, decision.retryAfterSec, decision.reason, https, kind);
        }
      } catch (e) {
        // FAIL CLOSED: without a working limiter we must not expose the
        // outbound Siteverify call. Data routes are unaffected.
        log("rate_limit_store_error", { rule: ruleName, error: e instanceof Error ? e.message : "unknown" });
        return NextResponse.json({ error: "temporarily_unavailable" }, {
          status: 503, headers: { ...BASE_SECURITY_HEADERS, ...stamp, ...(https ? { "Strict-Transport-Security": HSTS } : {}), "Retry-After": "30", "Cache-Control": "no-store" },
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
    for (const [k, v] of Object.entries({ ...BASE_SECURITY_HEADERS, ...stamp })) res.headers.set(k, v);
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
  for (const [k, v] of Object.entries({ ...BASE_SECURITY_HEADERS, ...stamp })) res.headers.set(k, v);
  if (https) res.headers.set("Strict-Transport-Security", HSTS);
  if (!sessionId && request.method === "GET") {
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
