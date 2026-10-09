import "server-only";
import { NextResponse } from "next/server";
import { data } from "./data";
import { InvalidQueryError } from "./data/types";
import { API_CSP, NO_STORE, PUBLIC_API_CACHE } from "./security/headers";

/**
 * JSON helpers for the public, read-only BFF API.
 * Success responses are shared-cacheable (no cookies, no personalization);
 * errors are never cached.
 */
const base = { "Content-Security-Policy": API_CSP, "X-Content-Type-Options": "nosniff" };

export function ok(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: { ...base, "Cache-Control": PUBLIC_API_CACHE } });
}

export function fail(status: 400 | 404 | 500 | 503, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: { ...base, "Cache-Control": NO_STORE } });
}

/** Wraps a handler: maps validation errors to 400 and hides internals on 5xx. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof InvalidQueryError) return fail(400, e.code);
    console.error(JSON.stringify({ at: new Date().toISOString(), event: "api_error", error: e instanceof Error ? e.message : "unknown" }));
    return fail(503, "temporarily_unavailable");
  }
}

export async function envelope<T>(payload: T) {
  const meta = await data().meta();
  return { dataset: meta.mode, publicationId: meta.publicationId, publishedAt: meta.publishedAt, data: payload };
}

export function rejectUnknownParams(url: URL, allowed: string[]): void {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) throw new InvalidQueryError("unknown_parameter");
}
