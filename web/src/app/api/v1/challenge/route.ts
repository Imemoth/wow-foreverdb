import { NextResponse } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { API_CSP } from "@/lib/security/headers";
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
  // CSRF / cross-site abuse: same-origin JSON only.
  const origin = req.headers.get("origin");
  if (origin !== new URL(env.SITE_URL).origin || !req.headers.get("content-type")?.startsWith("application/json")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers });
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > 4096) return NextResponse.json({ error: "payload_too_large" }, { status: 413, headers });
  const parsed = Body.safeParse(await req.json().catch(() => null));
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
