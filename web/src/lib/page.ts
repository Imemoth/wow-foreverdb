import "server-only";
import { headers } from "next/headers";
import { data } from "./data";
import { serverEnv } from "./env";

/** Per-request context for server components. Reading headers() keeps pages dynamic (required for nonce CSP). */
export async function pageContext() {
  const h = await headers();
  const env = serverEnv();
  return { nonce: h.get("x-nonce") ?? undefined, baseUrl: env.SITE_URL, db: data(), env };
}
