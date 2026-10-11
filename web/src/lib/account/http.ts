import "server-only";
import { NextResponse } from "next/server";
import { API_CSP, BASE_SECURITY_HEADERS } from "@/lib/security/headers";

/**
 * Response helpers for every /account/api/* handler. Account responses are NEVER shared-cacheable, never indexable
 * (in every deployment, production included), never leak a referrer, and carry the API CSP in addition to the headers
 * the proxy already adds.
 */
export const ACCOUNT_RESPONSE_HEADERS: Record<string, string> = {
  ...BASE_SECURITY_HEADERS,
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": API_CSP,
  Vary: "Cookie",
};

export function jsonResponse(body: Record<string, unknown>, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...ACCOUNT_RESPONSE_HEADERS, ...extra } });
}

export function failure(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextResponse {
  return jsonResponse({ ok: false, error, ...extra }, status, headers);
}

export function redirectResponse(location: URL | string, status: 303 | 307 = 303): NextResponse {
  return NextResponse.redirect(location, { status, headers: ACCOUNT_RESPONSE_HEADERS });
}

/**
 * Privacy-safe operational log: an event name plus a closed set of scalar fields. Emails, tokens, claim codes, user ids
 * and query strings are never passed here (and the field list is closed, so a caller cannot add one by accident).
 */
export function accountLog(event: string, fields: { route?: string; status?: number; code?: string | null; kind?: string } = {}): void {
  const { route, status, code, kind } = fields;
  console.info(JSON.stringify({ at: new Date().toISOString(), event: `account_${event}`, route, status, code: code ?? undefined, kind }));
}
