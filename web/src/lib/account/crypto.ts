/**
 * Account System V1 — small WebCrypto helpers (no Node `Buffer`, no I/O).
 *
 * One secret (`ACCOUNT_CSRF_SECRET`) is expanded with HKDF into independent, purpose-bound keys, so the CSRF MAC, the
 * session-cookie seal and the per-email throttle hash never share key material. Rotating the secret invalidates every
 * outstanding CSRF token and web session (users sign in again); it never exposes anything.
 */
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  try {
    const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function randomToken(bytes = 16): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison (length is not secret here: every compared value has a fixed format). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type KeyPurpose = "csrf-mac" | "session-seal" | "throttle-hash";

const keyCache = new Map<string, Promise<CryptoKey>>();

function derive(secret: string, purpose: KeyPurpose): Promise<CryptoKey> {
  const id = `${purpose}\u0000${secret}`;
  let k = keyCache.get(id);
  if (!k) {
    k = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
      const params = { name: "HKDF", hash: "SHA-256", salt: enc.encode("foreverdb-account-v1"), info: enc.encode(purpose) } as const;
      return purpose === "session-seal"
        ? crypto.subtle.deriveKey(params, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
        : crypto.subtle.deriveKey(params, ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
    })();
    keyCache.set(id, k);
    if (keyCache.size > 8) keyCache.delete(keyCache.keys().next().value as string);
  }
  return k;
}

export async function hmacB64(secret: string, purpose: "csrf-mac" | "throttle-hash", data: string): Promise<string> {
  const key = await derive(secret, purpose);
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

/** AES-256-GCM seal with a random IV; `aad` binds the ciphertext to its use (cookie name + format version). */
export async function seal(secret: string, plaintext: string, aad: string): Promise<string> {
  const key = await derive(secret, "session-seal");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext)));
  return `${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

/** Returns null for anything that is not an authentic, untampered sealed value for this `aad`. */
export async function unseal(secret: string, sealed: string, aad: string): Promise<string | null> {
  const parts = sealed.split(".");
  if (parts.length !== 2) return null;
  const iv = b64urlDecode(parts[0] ?? "");
  const ct = b64urlDecode(parts[1] ?? "");
  if (!iv || iv.length !== 12 || !ct || ct.length < 17) return null;
  try {
    const key = await derive(secret, "session-seal");
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: enc.encode(aad) }, key, ct as BufferSource));
  } catch {
    return null;
  }
}

/**
 * Payload of a JWT that came straight from Auth over the server-to-server TLS channel. UNVERIFIED: used only to read
 * `exp` and `session_id` of tokens we just received (to schedule a refresh and bind the CSRF token), never to decide
 * who the caller is. Authorization always goes through the server-confirmed user (GET /user).
 */
export function unverifiedJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const seg = parts[1];
  if (parts.length !== 3 || !seg) return null;
  const bytes = b64urlDecode(seg);
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(dec.decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
