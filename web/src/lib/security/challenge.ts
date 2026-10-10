/**
 * Shared request guards for POST /api/v1/challenge (the only state-changing
 * endpoint). Used by BOTH the proxy (cheap pre-checks before any rate-limit
 * counter is touched) and the route handler (defence in depth).
 */

export const CHALLENGE_PATH = "/api/v1/challenge";
/** Hard ceiling for the request body, enforced on the bytes actually read. */
export const MAX_CHALLENGE_BODY_BYTES = 4096;

/** Same-origin JSON POST only. Never consults a client-controlled identity. */
export function isSameOriginJson(headers: Headers, siteUrl: string): boolean {
  return headers.get("origin") === new URL(siteUrl).origin
    && (headers.get("content-type") ?? "").toLowerCase().startsWith("application/json");
}

export type BoundedJson =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: "invalid_body" | "invalid_content_length" | "payload_too_large" };

/**
 * Reads and parses a JSON body while enforcing `maxBytes` on the bytes that
 * actually arrive. `Content-Length` is only an early hint: a missing,
 * understated or lying header can never admit an oversized body, because the
 * stream is counted and cancelled as soon as the ceiling is exceeded.
 */
export async function readBoundedJson(req: Request, maxBytes = MAX_CHALLENGE_BODY_BYTES): Promise<BoundedJson> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,12}$/.test(declared.trim())) return { ok: false, status: 400, error: "invalid_content_length" };
    if (Number(declared) > maxBytes) return { ok: false, status: 413, error: "payload_too_large" };
  }
  if (!req.body) return { ok: false, status: 400, error: "invalid_body" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "payload_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
  if (received === 0) return { ok: false, status: 400, error: "invalid_body" };

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, error: "invalid_body" };
  }
}
