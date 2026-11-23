import "server-only";
import type { ZodType } from "@/lib/zod";
import type { AccountAuthConfig } from "@/lib/account/config";
import { CMS_RPCS } from "../cms-contract";
import { auditOutput, contextOutput, detailOutput, listOutput, revisionOutput, uuidOutput } from "./schemas";

/**
 * THE single database client of the Admin CMS (the PostgREST counterpart of lib/account/rpc-client.ts), closed in every dimension:
 *  - only the fixed RPC names below can be addressed (no table, schema, view, filter, header or `Prefer` value ever comes from a caller);
 *  - the ONLY credentials sent are the publishable key and the staff member's OWN, server-verified access token: no service-role
 *    credential, worker credential or MAC key exists in the website;
 *  - the target is the validated Account Auth origin, redirects are never followed, the call has an explicit timeout and a bounded
 *    response, and nothing is cached or logged here;
 *  - outputs are parsed with strict schemas (an unexpected column fails closed);
 *  - PostgreSQL error text is NEVER returned to a caller: it is classified into a closed machine verdict.
 */
export type DenialReason =
  | "forbidden"
  | "independent_approval_required"
  | "approver_ineligible"
  | "classification_downgrade"
  | "not_publishable"
  | "nothing_to_unpublish";
export type InvalidReason = "snapshot" | "image_rights" | "slug" | "request" | "decision" | "input";
export type ConflictReason = "request_reused" | "slug_taken";

export type CmsFailure =
  | { ok: false; kind: "unauthenticated" }
  | { ok: false; kind: "denied"; reason: DenialReason }
  | { ok: false; kind: "invalid"; reason: InvalidReason }
  | { ok: false; kind: "stale" }
  | { ok: false; kind: "conflict"; reason: ConflictReason }
  | { ok: false; kind: "rate_limited"; retryAfterSec: number }
  /** The call definitely did not change anything (or it is a read): safe to retry. */
  | { ok: false; kind: "unavailable" }
  /** A mutation was (or may have been) delivered but its result is unknown: retry ONLY with the same request id. */
  | { ok: false; kind: "unknown_outcome" };
export type CmsResult<T> = { ok: true; data: T } | CmsFailure;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;

const DENIAL: Record<string, DenialReason> = {
  "independent highlighted approval required": "independent_approval_required",
  "independent current approval required": "independent_approval_required",
  "approver no longer eligible": "approver_ineligible",
  "approver authority expired during audit wait": "approver_ineligible",
  "approver eligibility expired during publication": "approver_ineligible",
  "classification downgrade forbidden": "classification_downgrade",
  "revision not publishable": "not_publishable",
  "nothing to unpublish": "nothing_to_unpublish",
};
const INVALID: [RegExp, InvalidReason][] = [
  [/^invalid article slug/, "slug"],
  [/^image rights not verified|^invalid image reference/, "image_rights"],
  [/^invalid article snapshot|^featured content must be highlighted/, "snapshot"],
  [/^invalid review decision/, "decision"],
  [/^invalid editorial request/, "request"],
];

/** Classifies a PostgREST/PostgreSQL error body. Only the SQLSTATE code and a closed set of known messages are interpreted. */
export function classifyDbError(status: number, body: unknown): CmsFailure | null {
  if (status === 401) return { ok: false, kind: "unauthenticated" };
  if (status === 429) return { ok: false, kind: "rate_limited", retryAfterSec: 60 };
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof o.code === "string" ? o.code : "";
  const message = typeof o.message === "string" ? o.message : "";
  if (code === "42501" || status === 403) return { ok: false, kind: "denied", reason: DENIAL[message] ?? "forbidden" };
  if (code === "40001") return { ok: false, kind: "stale" };
  if (code === "23505") return { ok: false, kind: "conflict", reason: /request id reused/.test(message) ? "request_reused" : "slug_taken" };
  if (code === "22023") return { ok: false, kind: "invalid", reason: INVALID.find(([re]) => re.test(message))?.[1] ?? "input" };
  if (status === 400) return { ok: false, kind: "invalid", reason: "input" };
  return null;
}

async function readBounded(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

interface Spec<T> { name: string; args: Record<string, unknown>; output: ZodType<T>; mutating: boolean }

async function call<T>(cfg: AccountAuthConfig, spec: Spec<T>, accessToken: string): Promise<CmsResult<T>> {
  if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192 || /[\s\r\n]/.test(accessToken)) throw new Error("cms_rpc_bad_token");
  const lost: CmsFailure = spec.mutating ? { ok: false, kind: "unknown_outcome" } : { ok: false, kind: "unavailable" };
  let res: Response;
  try {
    res = await fetch(`${cfg.authOrigin}/rest/v1/rpc/${spec.name}`, {
      method: "POST",
      headers: { apikey: cfg.publishableKey, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(spec.args),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { return lost; }
  const text = await readBounded(res);
  let json: unknown = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  if (res.status === 429) {
    const v = Number(res.headers.get("retry-after"));
    return { ok: false, kind: "rate_limited", retryAfterSec: Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 3600) : 60 };
  }
  if (res.status < 200 || res.status >= 300) {
    // A recognised database verdict means the transaction was rolled back: definitely not applied.
    const verdict = classifyDbError(res.status, json);
    if (verdict) return verdict;
    // PostgREST refusing BEFORE execution (function not in the schema cache, unsupported media type): definitely not run.
    if (res.status === 404 || res.status === 405 || res.status === 406 || res.status === 415) return { ok: false, kind: "unavailable" };
    return lost;
  }
  if (text === null) return lost;
  const parsed = spec.output.safeParse(json);
  return parsed.success ? { ok: true, data: parsed.data } : lost;
}

const uuidArgs = <T extends Record<string, string>>(x: T) => x;

export const cmsRpc = {
  context: (cfg: AccountAuthConfig, token: string) => call(cfg, { name: "fdb_cms_context", args: {}, output: contextOutput, mutating: false }, token),
  articles: (cfg: AccountAuthConfig, token: string, limit = 100) =>
    call(cfg, { name: "fdb_cms_articles", args: { p_limit: Math.max(1, Math.min(100, Math.trunc(limit))) }, output: listOutput, mutating: false }, token),
  detail: (cfg: AccountAuthConfig, token: string, articleId: string) =>
    call(cfg, { name: "fdb_cms_article_detail", args: uuidArgs({ p_article: articleId }), output: detailOutput, mutating: false }, token),
  revision: (cfg: AccountAuthConfig, token: string, articleId: string, revisionId: string) =>
    call(cfg, { name: "fdb_cms_revision", args: uuidArgs({ p_article: articleId, p_revision: revisionId }), output: revisionOutput, mutating: false }, token),
  audit: (cfg: AccountAuthConfig, token: string, limit = 50, before: number | null = null) =>
    call(cfg, { name: "fdb_cms_audit", args: { p_limit: Math.max(1, Math.min(100, Math.trunc(limit))), p_before: before }, output: auditOutput, mutating: false }, token),

  create: (cfg: AccountAuthConfig, token: string, a: { article: string; slug: string; snapshot: unknown; request: string }) =>
    call(cfg, { name: CMS_RPCS.create, args: { p_article: a.article, p_slug: a.slug, p_snapshot: a.snapshot, p_request: a.request }, output: uuidOutput, mutating: true }, token),
  edit: (cfg: AccountAuthConfig, token: string, a: { article: string; revision: string; snapshot: unknown; request: string }) =>
    call(cfg, { name: CMS_RPCS.edit, args: { p_article: a.article, p_revision: a.revision, p_snapshot: a.snapshot, p_request: a.request }, output: uuidOutput, mutating: true }, token),
  submit: (cfg: AccountAuthConfig, token: string, a: { article: string; revision: string; request: string }) =>
    call(cfg, { name: CMS_RPCS.submit, args: { p_article: a.article, p_revision: a.revision, p_request: a.request }, output: uuidOutput, mutating: true }, token),
  review: (cfg: AccountAuthConfig, token: string, a: { article: string; revision: string; decision: "return" | "reject"; note: string; request: string }) =>
    call(cfg, { name: CMS_RPCS.review, args: { p_article: a.article, p_revision: a.revision, p_decision: a.decision, p_note: a.note, p_request: a.request }, output: uuidOutput, mutating: true }, token),
  approve: (cfg: AccountAuthConfig, token: string, a: { article: string; revision: string; request: string }) =>
    call(cfg, { name: CMS_RPCS.approveHighlighted, args: { p_article: a.article, p_revision: a.revision, p_request: a.request }, output: uuidOutput, mutating: true }, token),
  publish: (cfg: AccountAuthConfig, token: string, a: { article: string; revision: string; request: string }) =>
    call(cfg, { name: CMS_RPCS.publishIntent, args: { p_article: a.article, p_revision: a.revision, p_request: a.request }, output: uuidOutput, mutating: true }, token),
  unpublish: (cfg: AccountAuthConfig, token: string, a: { article: string; request: string }) =>
    call(cfg, { name: CMS_RPCS.unpublishIntent, args: { p_article: a.article, p_request: a.request }, output: uuidOutput, mutating: true }, token),
};
