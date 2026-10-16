import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import type { ZodType } from "zod";
import { readBoundedJson } from "@/lib/security/challenge";
import { auth } from "./auth-client";
import { FORM_CSRF_FIELD, verifyCsrf, verifyFormRequest, verifyFormToken } from "./csrf";
import { accountLog, failure, jsonResponse, redirectResponse } from "./http";
import { chargeEmail, type EmailAction } from "./limits";
import { accountRuntime, type AccountContext } from "./runtime";
import { DEVICE_MESSAGES } from "./messages";
import { jarFrom, readSession, type CookieJar, type StoredSession } from "./session";
import { verifyTurnstile } from "./turnstile";

/**
 * Wrapper every /account/api/* route handler goes through. It enforces, in this order and before any handler code:
 *   1. disabled -> 404, unavailable protections -> 503 (never partially on);
 *   2. for mutating routes: Origin / Fetch-Metadata / JSON / signed double-submit CSRF (login CSRF included);
 *   3. a bounded, strictly validated JSON body (handlers receive the parsed value only).
 * A route may instead declare `form`: a native <form method=post> endpoint (a file download cannot go through page JavaScript).
 * It gets the equivalent checks (Origin / Fetch Metadata, form content type, session-bound signed token in the body, bounded strict
 * body) and, for a browser navigation, failures are shown as a redirect back to the page instead of raw JSON.
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
  /** Native form POST (urlencoded) instead of JSON: `body` is then ignored, `back` is the page failures return to. */
  form?: { body: ZodType<B>; back: string };
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
      if (opts.mutating && !opts.form) {
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
      if (opts.form) {
        const { back } = opts.form;
        const shown = (res: NextResponse) => browserFailure(req, ac.siteOrigin, back, res);
        const request = verifyFormRequest(req.headers, ac.siteOrigin);
        if (request !== "ok") {
          accountLog("csrf_rejected", { route: opts.route, kind: request });
          return shown(failure(403, "forbidden"));
        }
        const raw = await readBoundedForm(req, 4096);
        if (!raw.ok) return shown(failure(raw.status, raw.error));
        if (!(await verifyFormToken(ac.cfg.csrfSecret, raw.fields[FORM_CSRF_FIELD], stored))) {
          accountLog("csrf_rejected", { route: opts.route, kind: "token" });
          return shown(failure(403, "csrf"));
        }
        const rest = { ...raw.fields };
        delete rest[FORM_CSRF_FIELD];
        const parsed = opts.form.body.safeParse(rest);
        if (!parsed.success) return shown(failure(400, "invalid_input"));
        return shown(await fn({ req, ac, jar, stored }, parsed.data));
      }
      return await fn({ req, ac, jar, stored }, body);
    } catch (e) {
      accountLog("handler_error", { route: opts.route, kind: e instanceof Error ? e.name : "unknown" });
      return failure(500, "internal_error");
    }
  };
}

type BoundedForm = { ok: true; fields: Record<string, string> } | { ok: false; status: 400 | 413; error: "invalid_body" | "payload_too_large" };

/** Bounded application/x-www-form-urlencoded body: counted on the bytes that arrive; a repeated field is refused. */
async function readBoundedForm(req: NextRequest, maxBytes: number): Promise<BoundedForm> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d{1,12}$/.test(declared.trim()) || Number(declared) > maxBytes)) return { ok: false, status: 413, error: "payload_too_large" };
  if (!req.body) return { ok: false, status: 400, error: "invalid_body" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.byteLength; }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, v] of new URLSearchParams(text)) {
    if (k in fields) return { ok: false, status: 400, error: "invalid_body" };
    fields[k] = v;
  }
  return { ok: true, fields: { ...fields } };
}

/**
 * A browser that submitted a native form and got a JSON failure would be left looking at raw JSON: send it back to the page with a
 * closed notice code instead (never request data). Non-browser callers (no text/html in Accept) keep the exact JSON status.
 * Set-Cookie (a refreshed or cleared session) and Retry-After are carried over.
 */
async function browserFailure(req: NextRequest, siteOrigin: string, back: string, res: NextResponse): Promise<NextResponse> {
  if (res.status < 400 || !(req.headers.get("accept") ?? "").toLowerCase().includes("text/html")) return res;
  let code = "error";
  try {
    const j = (await res.clone().json()) as { error?: unknown };
    if (typeof j.error === "string") code = j.error;
  } catch {
    // not our JSON failure: generic notice
  }
  const target = code === "unauthenticated" ? `/account/login?reason=expired&next=${encodeURIComponent(back)}` : `${back}?notice=${Object.hasOwn(DEVICE_MESSAGES, code) ? code : "error"}`;
  const out = redirectResponse(new URL(target, siteOrigin));
  for (const c of res.headers.getSetCookie()) out.headers.append("Set-Cookie", c);
  const retry = res.headers.get("retry-after");
  if (retry) out.headers.set("Retry-After", retry);
  return out;
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

/**
 * A new sign-in replaces the cookie of an earlier web session in this browser. Revoke that earlier Auth session (scope=local, this
 * browser's own session only) so it does not stay alive, unreachable, until its refresh token is eventually used. Best effort: an
 * expired access token or an outage just leaves the old session to expire on its own.
 */
export async function revokeReplacedSession(c: RouteContext): Promise<void> {
  if (!c.stored) return;
  await auth.logout(c.ac.cfg, c.stored.at).catch(() => undefined);
}

/** Fixed minimum duration for the mail routes, so "an e-mail was sent" and "nothing to send" take about the same time. */
export const MAIL_ROUTE_MIN_MS = 700;
export async function padMailRoute(startedAt: number): Promise<void> {
  const wait = MAIL_ROUTE_MIN_MS - (Date.now() - startedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export { jsonResponse };
