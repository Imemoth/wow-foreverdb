// Database access for the worker: ONLY the two named, audited RPCs (public.azerdex_welcome_claim / _finish), executable solely by the
// server-side role. No table access, no SQL text, no recipient input.
import type { WorkerConfig } from "./config.ts";
import type { ClaimedJob, Db, FinishArgs } from "./worker.ts";
import type { FetchLike } from "./resend.ts";

export function createDb(cfg: WorkerConfig, f: FetchLike): Db {
  const call = async (fn: string, body: unknown): Promise<unknown> => {
    const res = await f(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: cfg.dbKey, authorization: `Bearer ${cfg.dbKey}`, "content-type": "application/json", "content-profile": "public" },
      body: JSON.stringify(body),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`rpc_${fn}_${res.status}`); // status only, never the body
    return res.json();
  };
  return {
    async claim(limit: number): Promise<ClaimedJob[]> {
      const rows = await call("azerdex_welcome_claim", { p_limit: limit });
      if (!Array.isArray(rows)) throw new Error("rpc_claim_shape");
      return rows.filter(
        (r): r is ClaimedJob =>
          typeof r?.user_id === "string" && typeof r?.recipient === "string" && typeof r?.lease_token === "string" && typeof r?.idempotency_key === "string" && typeof r?.attempt === "number",
      );
    },
    async finish(a: FinishArgs): Promise<boolean> {
      return (await call("azerdex_welcome_finish", {
        p_user_id: a.user_id,
        p_lease_token: a.lease_token,
        p_outcome: a.outcome,
        p_provider_id: a.provider_id ?? null,
        p_error_code: a.error_code ?? null,
        p_retry_after_seconds: a.retry_after_seconds ?? null,
      })) === true;
    },
  };
}
