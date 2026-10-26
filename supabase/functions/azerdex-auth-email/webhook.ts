// Standard Webhooks signature verification (the scheme Supabase Auth uses for Auth Hooks), implemented with WebCrypto only so it can be tested
// offline and has no runtime dependency. Signed content: `${webhook-id}.${webhook-timestamp}.${raw body}`, HMAC-SHA256 with the base64 key that follows
// `whsec_` in the Supabase-generated secret (`v1,whsec_<base64>`). The header may carry several space-separated `v1,<base64>` signatures.
const enc = new TextEncoder();
export const TOLERANCE_SECONDS = 300;

function b64decode(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The key bytes of a Supabase hook secret, or null when the secret is missing or malformed (fail closed). */
export function hookKey(secret: string): Uint8Array<ArrayBuffer> | null {
  const m = /^(?:v1,)?whsec_([A-Za-z0-9+/=]+)$/.exec(secret.trim());
  const key = m ? b64decode(m[1]) : null;
  return key && key.length >= 16 ? key : null;
}

export async function verifyWebhook(rawBody: string, headers: { get(n: string): string | null }, secret: string, nowMs = Date.now()): Promise<boolean> {
  const key = hookKey(secret);
  const id = headers.get("webhook-id") ?? "";
  const ts = headers.get("webhook-timestamp") ?? "";
  const sigs = (headers.get("webhook-signature") ?? "").split(" ").filter(Boolean);
  if (!key || !id || !/^\d{1,12}$/.test(ts) || sigs.length === 0 || sigs.length > 8) return false;
  if (Math.abs(nowMs / 1000 - Number(ts)) > TOLERANCE_SECONDS) return false;
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`${id}.${ts}.${rawBody}`)));
  let ok = false;
  for (const s of sigs) {
    const m = /^v1,([A-Za-z0-9+/=]+)$/.exec(s);
    const given = m ? b64decode(m[1]) : null;
    if (given && equal(given, mac)) ok = true; // no early exit: every candidate is compared
  }
  return ok;
}
