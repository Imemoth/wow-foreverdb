import "server-only";
import type { NextRequest, NextResponse } from "next/server";
import { checkCsrf, originAllowed } from "@/lib/account/csrf";
import { timingSafeEqualStr } from "@/lib/account/crypto";
import { failure, jsonResponse } from "@/lib/account/http";
import { chargeAccount } from "@/lib/account/limits";
import { jarFrom } from "@/lib/account/session";
import { readBoundedJson } from "@/lib/security/challenge";
import { adminRuntime } from "../runtime";
import { adminCsrfCookie, readAdminSession, resolveAdminSessionToken } from "../session";
import { articleIdForRequest } from "./ids";
import { cmsRpc, type CmsFailure, type CmsResult } from "./rpc";
import { ACTION_INPUT, ACTION_NAMES, READ_INPUT, type ActionName } from "./schemas";

/** 256 KiB: the article body is capped at 50 000 characters (<= 200 KB as UTF-8) plus metadata. */
export const MAX_ACTION_BODY_BYTES = 256 * 1024;

const STATUS: Record<CmsFailure["kind"], number> = {
  unauthenticated: 401, denied: 403, invalid: 422, stale: 409, conflict: 409, rate_limited: 429, unavailable: 503, unknown_outcome: 503,
};

/** A closed, browser-safe error. Never database text; `unknownOutcome` tells the UI to retry ONLY with the same request id. */
export function errorResponse(f: CmsFailure): NextResponse {
  const body: Record<string, unknown> = { kind: f.kind };
  if ("reason" in f) body.reason = f.reason;
  if (f.kind === "unknown_outcome") body.unknownOutcome = true;
  const headers: Record<string, string> = f.kind === "rate_limited" ? { "Retry-After": String(f.retryAfterSec) } : {};
  return jsonResponse({ ok: false, error: body }, STATUS[f.kind], headers);
}

const ok = <T,>(r: CmsResult<T>, then: (d: T) => Record<string, unknown>): NextResponse => (r.ok ? jsonResponse({ ok: true, ...then(r.data) }) : errorResponse(r));

/**
 * POST /admin/api/cms/<action>. In this order and before any database call:
 *   1. the Admin runtime must be enabled (local disposable only) and the action must be one of the fixed names;
 *   2. an Admin session cookie must exist; Origin / Fetch-Metadata, JSON content type and the session-bound signed double-submit CSRF token
 *      must all hold (the same protocol as /admin/api/logout);
 *   3. the body is size-bounded and strictly validated (unknown keys are refused);
 *   4. a per-account budget is charged (a store outage refuses the request: fail closed);
 *   5. the live Auth identity and the private entry/freshness decision are re-verified, then the database call runs as the staff member.
 * The database authorizes every call again (policy, scope, grants, independence, TOTP freshness); nothing here grants anything.
 */
export async function handleCmsPost(req: NextRequest, action: string): Promise<NextResponse> {
  const rt = adminRuntime();
  if (rt.state !== "ready") return failure(404, "not_found");
  const isAction = (ACTION_NAMES as string[]).includes(action);
  if (!isAction && action !== "revision") return failure(404, "not_found");
  const jar = jarFrom(() => req.cookies.getAll());
  const s = await readAdminSession(rt.ac, jar);
  if (!s) return failure(401, "admin_denied");
  const header = req.headers.get("x-fdb-csrf") ?? "";
  const cookie = jar.get(adminCsrfCookie) ?? "";
  if (!originAllowed(req.headers, rt.ac.siteOrigin)
    || !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")
    || !header || !cookie || !timingSafeEqualStr(header, cookie)
    || !(await checkCsrf(rt.ac.cfg.csrfSecret, header, `admin:${s.sid}`))) return failure(403, "csrf");

  const raw = await readBoundedJson(req, MAX_ACTION_BODY_BYTES);
  if (!raw.ok) return failure(raw.status, raw.error);
  const schema = isAction ? ACTION_INPUT[action as ActionName] : READ_INPUT.revision;
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) {
    // Field paths and a closed code only: never the submitted values.
    const issues = parsed.error.issues.slice(0, 12).map((i) => ({ path: i.path.map(String).join("."), code: i.code === "custom" ? String(i.message) : i.code }));
    return jsonResponse({ ok: false, error: { kind: "invalid", reason: "input", issues } }, 422);
  }
  try {
    const budget = await chargeAccount(rt.ac.env, rt.ac.cfg.csrfSecret, isAction ? "admin_cms_write" : "admin_cms_read", s.uid);
    if (budget.budget === "exhausted") return errorResponse({ ok: false, kind: "rate_limited", retryAfterSec: budget.retryAfterSec });
  } catch { return failure(503, "temporarily_unavailable"); }

  const live = await resolveAdminSessionToken(rt.ac, jar);
  if (!live.ok) return failure(401, "admin_denied");
  const { cfg } = rt.ac;
  const at = live.at;
  switch (action) {
    case "create": {
      const b = parsed.data as ReturnType<(typeof ACTION_INPUT.create)["parse"]>;
      const article = articleIdForRequest(b.requestId);
      return ok(await cmsRpc.create(cfg, at, { article, slug: b.slug, snapshot: b.snapshot, request: b.requestId }), () => ({ articleId: article }));
    }
    case "edit": {
      const b = parsed.data as ReturnType<(typeof ACTION_INPUT.edit)["parse"]>;
      return ok(await cmsRpc.edit(cfg, at, { article: b.articleId, revision: b.revisionId, snapshot: b.snapshot, request: b.requestId }), (id) => ({ articleId: b.articleId, revisionId: id }));
    }
    case "submit": {
      const b = parsed.data as ReturnType<(typeof ACTION_INPUT.submit)["parse"]>;
      return ok(await cmsRpc.submit(cfg, at, { article: b.articleId, revision: b.revisionId, request: b.requestId }), () => ({ articleId: b.articleId }));
    }
    case "review": {
      const b = parsed.data as ReturnType<(typeof ACTION_INPUT.review)["parse"]>;
      return ok(await cmsRpc.review(cfg, at, { article: b.articleId, revision: b.revisionId, decision: b.decision, note: b.note, request: b.requestId }), () => ({ articleId: b.articleId }));
    }
    case "approve": {
      const b = parsed.data as ReturnType<(typeof ACTION_INPUT.approve)["parse"]>;
      return ok(await cmsRpc.approve(cfg, at, { article: b.articleId, revision: b.revisionId, request: b.requestId }), () => ({ articleId: b.articleId }));
    }
    case "publish": {
      const b = parsed.data as ReturnType<(typeof ACTION_INPUT.publish)["parse"]>;
      return ok(await cmsRpc.publish(cfg, at, { article: b.articleId, revision: b.revisionId, request: b.requestId }), (id) => ({ articleId: b.articleId, intentId: id }));
    }
    case "unpublish": {
      const b = parsed.data as ReturnType<(typeof ACTION_INPUT.unpublish)["parse"]>;
      return ok(await cmsRpc.unpublish(cfg, at, { article: b.articleId, request: b.requestId }), (id) => ({ articleId: b.articleId, intentId: id }));
    }
    default: {
      const b = parsed.data as ReturnType<(typeof READ_INPUT.revision)["parse"]>;
      return ok(await cmsRpc.revision(cfg, at, b.articleId, b.revisionId), (revision) => ({ revision }));
    }
  }
}
