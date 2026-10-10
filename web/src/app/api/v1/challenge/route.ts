import { NextResponse } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { API_CSP } from "@/lib/security/headers";
import { MAX_CHALLENGE_BODY_BYTES, isSameOriginJson, readBoundedJson } from "@/lib/security/challenge";
import { clientIp, hashIp, signPass } from "@/lib/security/identity";

/**
 * Progressive bot challenge: verifies a Cloudflare Turnstile token SERVER-SIDE
 * and issues a short-lived, IP-bound, HMAC-signed pass cookie. Disabled (404)
 * unless Turnstile is configured.
 */
const Body = z.object({ token: z.string().min(10).max(2048) }).strict();
const headers = { "Content-Security-Policy": API_CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function POST(req: Request) {
  const env = serverEnv();
  if (!env.TURNSTILE_SECRET_KEY || !env.CHALLENGE_COOKIE_SECRET) {
    return NextResponse.json({ error: "challenge_not_configured" }, { status: 404, headers });
  }
  // CSRF / cross-site abuse: same-origin JSON only. (Rate limiting happens in
  // src/proxy.ts BEFORE this handler runs; see docs/web/api-contract.md.)
  if (!isSameOriginJson(req.headers, env.SITE_URL)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  }
  // The body ceiling is enforced on the bytes actually read, never on the
  // client-supplied Content-Length alone.
  const body = await readBoundedJson(req, MAX_CHALLENGE_BODY_BYTES);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status, headers });
  const parsed = Body.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400, headers });

  const ip = clientIp(req.headers, env.TRUSTED_IP_HEADER);
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: parsed.data.token });
  if (ip !== "local" && ip !== "unknown" && ip !== "invalid") form.set("remoteip", ip);
  let success = false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body: form, signal: AbortSignal.timeout(5000), cache: "no-store",
    });
    success = r.ok && ((await r.json()) as { success?: boolean }).success === true;
  } catch {
    return NextResponse.json({ error: "verification_unavailable" }, { status: 503, headers });
  }
  if (!success) return NextResponse.json({ error: "verification_failed" }, { status: 403, headers });

  const res = NextResponse.json({ ok: true }, { headers });
  res.cookies.set("fdb_pass", signPass(hashIp(ip, env.RATE_LIMIT_SALT), env.CHALLENGE_COOKIE_SECRET), {
    httpOnly: true, secure: env.SITE_URL.startsWith("https://"), sameSite: "strict", path: "/", maxAge: 1800,
  });
  return res;
}
