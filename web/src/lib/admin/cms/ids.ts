import "server-only";
import { createHash } from "node:crypto";

/**
 * A create request carries ONE idempotency key. The article UUID is derived from it on the server (the database wants an opaque,
 * server-chosen id), so a retry of the same intent addresses the same article and the database returns the original result
 * instead of reporting a reused request id. The id is not a secret and grants nothing: authority is the database's decision.
 */
export function articleIdForRequest(requestId: string): string {
  const h = createHash("sha256").update(`fdb-cms-article-v1|${requestId.toLowerCase()}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x40; // version 4 layout
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
