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
  // One abort signal covers connect, headers AND the body read: a provider that stalls after the headers is still cut off.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), args.timeoutMs);
  try {
    const res = await args.fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${args.apiKey}`, "content-type": "application/json", "idempotency-key": args.idempotencyKey },
      body: JSON.stringify(args.payload),
      signal: ctl.signal,
      redirect: "error",
    });
    return await classify(res);
  } catch (e) {
    return { kind: "ambiguous", code: (e as Error)?.name === "AbortError" ? "provider_timeout" : "provider_transport" };
  } finally {
    clearTimeout(timer);
  }
}

async function classify(res: Response): Promise<SendOutcome> {
  // Never keep the provider's body beyond the id: it can echo the recipient.
  if (res.status === 200 || res.status === 201) {
    try {
      const j = (await res.json()) as { id?: unknown };
      if (typeof j?.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(j.id)) return { kind: "accepted", providerId: j.id };
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e; // stalled body: report as a timeout
    }
    return { kind: "ambiguous", code: "provider_malformed_response" };
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 429) {
    const ra = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    return { kind: "retry", code: "provider_rate_limited", retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? Math.min(ra, MAX_RETRY_AFTER) : 60 };
  }
  // Any other 2xx (202, 204...), request timeout / locked / too-early answers and 409/5xx: the message MAY have been accepted.
  if (res.status >= 200 && res.status < 300) return { kind: "ambiguous", code: "provider_malformed_response" };
  if (res.status === 409) return { kind: "ambiguous", code: "provider_idempotency_conflict" };
  if (res.status >= 500 || res.status === 408 || res.status === 423 || res.status === 425) return { kind: "ambiguous", code: "provider_5xx" };
  if (res.status === 401 || res.status === 403) return { kind: "permanent", code: "provider_auth" };
  if (res.status === 422 || res.status === 400) return { kind: "permanent", code: "provider_rejected" };
  return { kind: "permanent", code: "provider_4xx" };
}
