// Resend sender with an explicit outcome taxonomy. The send is NOT assumed to be exactly-once: what matters is whether the provider
// definitely did not accept the message (safe to retry), definitely refused it (never retry), accepted it, or we cannot tell.

export type SendOutcome =
  | { kind: "accepted"; providerId: string }
  | { kind: "retry"; code: string; retryAfterSeconds: number } // provider definitely did not send (429)
  | { kind: "ambiguous"; code: string } // timeout, transport failure, 5xx, 409 in-flight, malformed 2xx: it MAY have been sent
  | { kind: "permanent"; code: string }; // 4xx the provider will not change its mind about

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAX_RETRY_AFTER = 3600;

export async function sendEmail(args: {
  fetch: FetchLike;
  apiKey: string;
  payload: unknown;
  idempotencyKey: string;
  timeoutMs: number;
}): Promise<SendOutcome> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), args.timeoutMs);
  let res: Response;
  try {
    res = await args.fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${args.apiKey}`, "content-type": "application/json", "idempotency-key": args.idempotencyKey },
      body: JSON.stringify(args.payload),
      signal: ctl.signal,
      redirect: "error",
    });
  } catch (e) {
    return { kind: "ambiguous", code: (e as Error)?.name === "AbortError" ? "provider_timeout" : "provider_transport" };
  } finally {
    clearTimeout(timer);
  }
  // Never read or keep the provider's body beyond the id: it can echo the recipient.
  if (res.status === 200 || res.status === 201) {
    try {
      const j = (await res.json()) as { id?: unknown };
      if (typeof j?.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(j.id)) return { kind: "accepted", providerId: j.id };
    } catch {
      /* fall through */
    }
    return { kind: "ambiguous", code: "provider_malformed_response" };
  }
  if (res.status === 429) {
    const ra = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    return { kind: "retry", code: "provider_rate_limited", retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? Math.min(ra, MAX_RETRY_AFTER) : 60 };
  }
  if (res.status === 409 || res.status >= 500) return { kind: "ambiguous", code: res.status === 409 ? "provider_idempotency_conflict" : "provider_5xx" };
  if (res.status === 401 || res.status === 403) return { kind: "permanent", code: "provider_auth" };
  if (res.status === 422 || res.status === 400) return { kind: "permanent", code: "provider_rejected" };
  return { kind: "permanent", code: "provider_4xx" };
}
