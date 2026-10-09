/**
 * Privacy-safe client identity for abuse controls.
 * Raw IP addresses are never stored or logged: only a keyed hash is used.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DEV_SALT = "foreverdb-local-development-salt-not-for-production";

export function clientIp(headers: Headers, trusted: "x-real-ip" | "x-forwarded-for" | "cf-connecting-ip" | "none"): string {
  if (trusted === "none") return "local";
  const raw = headers.get(trusted);
  if (!raw) return "unknown";
  // x-forwarded-for: the platform-appended client address is the FIRST entry
  // only when the platform overwrites the header (Vercel does). Configure accordingly.
  const first = raw.split(",")[0]!.trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(first) ? first : "invalid";
}

export function hashIp(ip: string, salt: string | undefined): string {
  return createHmac("sha256", salt ?? DEV_SALT).update(ip).digest("base64url").slice(0, 22);
}

export function newSessionId(): string {
  return randomBytes(16).toString("base64url"); // 22 chars
}

// ---------------------------------------------------------------- challenge pass
// A short-lived HMAC-signed cookie proving a server-side verified challenge,
// bound to the (hashed) client IP so it cannot be shared across networks.

export function signPass(ipHash: string, secret: string, ttlSec = 1800, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + ttlSec;
  const payload = `${ipHash}.${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyPass(cookie: string | undefined, ipHash: string, secret: string | undefined, nowMs = Date.now()): boolean {
  if (!cookie || !secret) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3) return false;
  const [h, expStr, sig] = parts as [string, string, string];
  if (h !== ipHash || !/^\d{1,12}$/.test(expStr) || Number(expStr) < Math.floor(nowMs / 1000)) return false;
  const expected = createHmac("sha256", secret).update(`${h}.${expStr}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
