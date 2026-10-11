import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import type { ZodType } from "zod";
import { readBoundedJson } from "@/lib/security/challenge";
import { verifyCsrf } from "./csrf";
import { accountLog, failure, jsonResponse } from "./http";
import { chargeEmail, type EmailAction } from "./limits";
import { accountRuntime, type AccountContext } from "./runtime";
import { jarFrom, readSession, type CookieJar, type StoredSession } from "./session";
import { verifyTurnstile } from "./turnstile";

/**
 * Wrapper every /account/api/* route handler goes through. It enforces, in this order and before any handler code:
 *   1. disabled -> 404, unavailable protections -> 503 (never partially on);
 *   2. for mutating routes: Origin / Fetch-Metadata / JSON / signed double-submit CSRF (login CSRF included);
 *   3. a bounded, strictly validated JSON body (handlers receive the parsed value only).
 * Exceptions become a generic 500 and are logged by name only. Only the HTTP methods a route exports are served
 * (Next answers 405 for the rest).
 */
export interface RouteContext {
  req: NextRequest;
  ac: AccountContext;
  jar: CookieJar;
  /** The web session in the cookie, UNVERIFIED (used for the CSRF binding only; identity comes from resolveSession). */
  stored: StoredSession | null;
}

export interface RouteOptions<B> {
  route: string;
  mutating: boolean;
  /** Body schema for mutating routes. */
  body?: ZodType<B>;
}

export function accountApi<B = undefined>(
  opts: RouteOptions<B>,
  fn: (c: RouteContext, body: B) => Promise<NextResponse>,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req) => {
    try {
      const rt = accountRuntime();
      if (rt.state === "disabled") return failure(404, "not_found");
      if (rt.state === "unavailable") {
        accountLog("unavailable", { route: opts.route, kind: rt.reason });
        return failure(503, "account_unavailable", {}, { "Retry-After": "300" });
      }
      const ac = rt.ctx;
      const jar = jarFrom(() => req.cookies.getAll());
      const { session: stored } = await readSession(ac.cfg.csrfSecret, jar, ac.https);

      let body = undefined as B;
      if (opts.mutating) {
        const verdict = await verifyCsrf({
          headers: req.headers,
          jar,
          cookieName: ac.cookies.csrf,
          siteOrigin: ac.siteOrigin,
          secret: ac.cfg.csrfSecret,
          session: stored,
        });
        if (verdict !== "ok") {
          accountLog("csrf_rejected", { route: opts.route, kind: verdict });
          return failure(403, verdict === "token" ? "csrf" : "forbidden");
        }
        const raw = await readBoundedJson(req, 4096);
        if (!raw.ok) return failure(raw.status, raw.error);
        if (opts.body) {
          const parsed = opts.body.safeParse(raw.value);
          if (!parsed.success) return failure(400, "invalid_input", { fields: parsed.error.issues.map((i) => i.path.join(".") || "body").slice(0, 8) });
          body = parsed.data;
        }
      }
      return await fn({ req, ac, jar, stored }, body);
    } catch (e) {
      accountLog("handler_error", { route: opts.route, kind: e instanceof Error ? e.name : "unknown" });
      return failure(500, "internal_error");
    }
  };
}

/**
 * Bot-check + per-address throttle shared by sign-up, resend and recovery. Returns a Response to send, or null to go on.
 * `exhausted: true` means the per-address budget is spent: the caller answers exactly like a success WITHOUT contacting Auth.
 */
export async function guardMailRoute(
  c: RouteContext,
  action: Exclude<EmailAction, "login">,
  email: string,
  turnstileToken: string | undefined,
): Promise<{ response: NextResponse } | { exhausted: boolean }> {
  if (c.ac.turnstileSecret) {
    if (!turnstileToken) return { response: failure(403, "challenge_required") };
    const verdict = await verifyTurnstile(c.ac.turnstileSecret, turnstileToken);
    if (verdict === "failed") return { response: failure(403, "challenge_failed") };
    if (verdict === "unavailable") return { response: failure(503, "challenge_unavailable", {}, { "Retry-After": "30" }) };
  }
  try {
    return { exhausted: (await chargeEmail(c.ac.env, c.ac.cfg.csrfSecret, action, email)) === "exhausted" };
  } catch {
    return { response: failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }) };
  }
}

export { jsonResponse };
