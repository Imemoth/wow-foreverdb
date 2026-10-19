import "server-only";
import { b64urlDecode, b64urlEncode, hmacB64, randomToken, timingSafeEqualStr } from "./crypto";

export const PAIRING_COOKIE_TTL_SEC = 5 * 60;
const PAIRING_COOKIE_AAD = "fdb-pairing-cookie-v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utf8 = new TextEncoder();
const text = new TextDecoder("utf-8", { fatal: true });

export interface PairingCookiePayload {
  v: 1;
  id: string;
  nonce: string;
  exp: number;
}

const PAGE_BINDING_PREFIX = "fdbpg1_";

/**
 * Opaque, non-authorizing proof that the rendered page belonged to this locator and exact verified web session.
 * It contains no identifier; the session, signed locator cookie and CSRF proof remain independently mandatory.
 */
export async function mintPairingPageBinding(secret: string, payload: PairingCookiePayload, userId: string, sessionId: string): Promise<string> {
  const mac = await hmacB64(secret, "pairing-page-mac", pairingPageMessage(payload, userId, sessionId));
  return `${PAGE_BINDING_PREFIX}${mac}`;
}

export async function verifyPairingPageBinding(secret: string, payload: PairingCookiePayload, userId: string, sessionId: string, value: string | null): Promise<boolean> {
  if (!value || !/^fdbpg1_[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return timingSafeEqualStr(value, await mintPairingPageBinding(secret, payload, userId, sessionId));
}

function pairingPageMessage(payload: PairingCookiePayload, userId: string, sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(userId) || sessionId.length < 1 || sessionId.length > 64) throw new Error("invalid_pairing_page_binding");
  return `fdb-pairing-page-v1|${canonicalPayload(payload)}|${userId.toLowerCase()}|${sessionId}`;
}

export function isCanonicalPairingId(value: string): boolean {
  return UUID_V4.test(value);
}

export function pairingCookieName(https: boolean): "__Secure-fdb_pair" | "fdb_pair" {
  return https ? "__Secure-fdb_pair" : "fdb_pair";
}

function canonicalPayload(payload: PairingCookiePayload): string {
  return JSON.stringify({ v: payload.v, id: payload.id, nonce: payload.nonce, exp: payload.exp });
}

export async function mintPairingCookie(secret: string, pairingId: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!isCanonicalPairingId(pairingId) || !Number.isSafeInteger(now)) throw new Error("invalid_pairing_cookie_input");
  const payload: PairingCookiePayload = { v: 1, id: pairingId, nonce: randomToken(16), exp: now + PAIRING_COOKIE_TTL_SEC };
  const encoded = b64urlEncode(utf8.encode(canonicalPayload(payload)));
  const mac = await hmacB64(secret, "pairing-cookie-mac", `${PAIRING_COOKIE_AAD}|${encoded}`);
  return `${encoded}.${mac}`;
}

export async function readPairingCookie(
  secret: string,
  value: string,
  now = Math.floor(Date.now() / 1000),
): Promise<PairingCookiePayload | null> {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !Number.isSafeInteger(now)) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [encoded, mac] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]{1,384}$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const expected = await hmacB64(secret, "pairing-cookie-mac", `${PAIRING_COOKIE_AAD}|${encoded}`);
  if (!timingSafeEqualStr(mac, expected)) return null;

  const bytes = b64urlDecode(encoded);
  if (!bytes || b64urlEncode(bytes) !== encoded) return null;
  let plain: string;
  let parsed: unknown;
  try {
    plain = text.decode(bytes);
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.v !== 1 || typeof candidate.id !== "string" || !isCanonicalPairingId(candidate.id) ||
      typeof candidate.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(candidate.nonce) ||
      typeof candidate.exp !== "number" || !Number.isSafeInteger(candidate.exp)) return null;
  const nonce = b64urlDecode(candidate.nonce);
  if (!nonce || nonce.byteLength !== 16 || b64urlEncode(nonce) !== candidate.nonce) return null;
  const payload: PairingCookiePayload = { v: 1, id: candidate.id, nonce: candidate.nonce, exp: candidate.exp };
  if (canonicalPayload(payload) !== plain) return null;
  if (payload.exp <= now || payload.exp > now + PAIRING_COOKIE_TTL_SEC) return null;
  return payload;
}

function cookieHeader(https: boolean, value: string, maxAge: number): string {
  const age = Math.min(PAIRING_COOKIE_TTL_SEC, Math.max(0, Math.floor(maxAge)));
  const parts = [`${pairingCookieName(https)}=${value}`, "Path=/account", `Max-Age=${age}`];
  if (age === 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  parts.push("HttpOnly");
  if (https) parts.push("Secure");
  parts.push("SameSite=Lax");
  return parts.join("; ");
}

export function setPairingCookie(headers: Headers, https: boolean, value: string, maxAge = PAIRING_COOKIE_TTL_SEC): void {
  headers.append("Set-Cookie", cookieHeader(https, value, maxAge));
}

export function clearPairingCookie(headers: Headers, https: boolean): void {
  headers.append("Set-Cookie", cookieHeader(https, "", 0));
}
