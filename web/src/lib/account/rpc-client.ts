import "server-only";
import { z } from "@/lib/zod";
import { ACCOUNT_RPCS, isAccountRpc, type AccountRpcName } from "./contracts";
import { ENROLLMENT_RPCS, isEnrollmentRpc, type EnrollmentRpcName } from "./contracts-enrollment";
import type { AccountAuthConfig } from "./config";

/**
 * THE single database RPC client of the website's account boundary (the PostgREST counterpart of auth-client.ts). It is the
 * only module that builds `/rest/v1/...` URLs (a static test enforces that), and it is closed in every dimension:
 *
 *   - only the functions of the reviewed `ACCOUNT_RPCS` registry (and the five ACCOUNT functions of the separate zero-touch
 *     `ENROLLMENT_RPCS` registry, migration 0014) that make sense for a registered WEB account can be named
 *     (`WEB_RPCS`): `fdb_account_claim_start` (the Companion's anonymous owner starts claims, never the website) and
 *     `fdb_installation_link_status` (a Companion call) are not reachable from here, and there is no generic entry point;
 *   - the target is derived from the validated Account Auth configuration (`cfg.authOrigin`), the path is `/rest/v1/rpc/<name>`
 *     and the method is always POST: no table, schema, view or filter access exists, and no caller-controlled header, query
 *     string or `Prefer` value is ever sent (so a transaction can never be rolled back or limited by a caller);
 *   - input and output are parsed with the registry's strict Zod schemas (extra output fields fail closed);
 *   - only the publishable key (`apikey`) and the user's OWN, server-verified access token are sent: no service credential
 *     exists in the website and the public loot database adapter is never imported here;
 *   - redirects are not followed, the request has an explicit timeout, the response is size-bounded and never cached;
 *   - nothing is logged here, and database error text is never returned (only a machine verdict).
 */

export const WEB_RPCS = [
  "fdb_account_claim_redeem",
  "fdb_account_installations",
] as const satisfies readonly AccountRpcName[];
export type WebRpcName = (typeof WEB_RPCS)[number];

/**
 * Zero-touch enrollment (0014): exactly the five website functions. The `fdb_device_*` functions belong to the Companion's own
 * anonymous identity and exist in no registry the website can reach, so they cannot be named here at all.
 */
export const WEB_ENROLLMENT_RPCS = [
  "fdb_account_enrollment_ticket_issue",
  "fdb_account_enrollment_tickets",
  "fdb_account_enrollment_ticket_revoke",
  "fdb_account_devices",
  "fdb_account_device_revoke",
] as const satisfies readonly EnrollmentRpcName[];
export type WebEnrollmentRpcName = (typeof WEB_ENROLLMENT_RPCS)[number];

type CallableRpcName = WebRpcName | WebEnrollmentRpcName;
const REGISTRY = { ...ACCOUNT_RPCS, ...ENROLLMENT_RPCS };

/**
 * One-time, state-changing calls: a lost reply is an UNKNOWN outcome, never a definite failure. For a ticket issue the ticket may
 * exist while its secret is lost: the user simply downloads another (never an automatic retry).
 */
const MUTATING: ReadonlySet<string> = new Set([
  "fdb_account_claim_redeem",
  "fdb_account_enrollment_ticket_issue",
  "fdb_account_enrollment_ticket_revoke",
  "fdb_account_device_revoke",
]);

const MAX_RESPONSE_BYTES = 512 * 1024; // 200 members x < 1 KiB, with generous headroom; anything larger is not ours
const TIMEOUT_MS = 8000;

export type RpcOutput<N extends CallableRpcName> = z.infer<(typeof REGISTRY)[N]["output"]>;

export type RpcFailure =
  /** 401: no valid, live session for this bearer (revoked, expired, forged, wrong user). Never an ordinary business failure. */
  | { ok: false; kind: "unauthenticated" }
  /** 403: the identity kind is wrong (not a confirmed registered account). */
  | { ok: false; kind: "forbidden" }
  /** 429: a database budget is exhausted. */
  | { ok: false; kind: "rate_limited"; retryAfterSec: number }
  /** 400: the database rejected the parameters (malformed ids / paging). */
  | { ok: false; kind: "bad_request" }
  /** The request definitely did not change anything, or the function is read-only: safe to retry later. */
  | { ok: false; kind: "unavailable" }
  /** A one-time call was (or may have been) delivered but its result is not known: reconcile, never auto-retry. */
  | { ok: false; kind: "unknown_outcome" };
export type RpcResult<N extends CallableRpcName> = { ok: true; data: RpcOutput<N> } | RpcFailure;

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
      if (n > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function retryAfter(res: Response): number {
  const v = Number(res.headers.get("retry-after"));
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 3600) : 60;
}

export async function callWebRpc<N extends CallableRpcName>(
  cfg: AccountAuthConfig,
  name: N,
  input: z.input<(typeof REGISTRY)[N]["input"]>,
  accessToken: string,
): Promise<RpcResult<N>> {
  // Programming errors, refused loudly before anything is sent.
  const allowed = (WEB_RPCS as readonly string[]).includes(name) ? isAccountRpc(name) : (WEB_ENROLLMENT_RPCS as readonly string[]).includes(name) && isEnrollmentRpc(name);
  if (!allowed) throw new Error("rpc_not_allowed");
  if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192 || /[\s\r\n]/.test(accessToken)) throw new Error("rpc_bad_token");
  const spec = REGISTRY[name];
  const body = (spec.input as z.ZodTypeAny).parse(input);
  const mutating = MUTATING.has(name);
  const lost: RpcFailure = mutating ? { ok: false, kind: "unknown_outcome" } : { ok: false, kind: "unavailable" };

  let res: Response;
  try {
    res = await fetch(`${cfg.authOrigin}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: cfg.publishableKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return lost; // timeout or connection failure: for a one-time call the request may have been processed
  }

  const text = await readBounded(res);
  if (res.status === 401) return { ok: false, kind: "unauthenticated" };
  if (res.status === 403) return { ok: false, kind: "forbidden" };
  if (res.status === 429) return { ok: false, kind: "rate_limited", retryAfterSec: retryAfter(res) };
  if (res.status === 400) return { ok: false, kind: "bad_request" };
  // PostgREST refusing BEFORE execution (function not in the schema cache, unsupported media type / profile): definitely not run.
  if (res.status === 404 || res.status === 405 || res.status === 406 || res.status === 415) return { ok: false, kind: "unavailable" };
  if (res.status < 200 || res.status >= 300) return lost; // 5xx, 3xx (redirects are refused), anything unexpected
  if (text === null) return lost; // oversized or truncated body

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return lost;
  }
  const parsed = (spec.output as z.ZodTypeAny).safeParse(json);
  if (!parsed.success) return lost; // an unexpected shape (extra column, wrong type) is never passed on
  return { ok: true, data: parsed.data as RpcOutput<N> };
}
