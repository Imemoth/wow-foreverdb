import "server-only";
import type { Metadata } from "next";
import { serverEnv } from "./env";

/**
 * Single source of truth for indexing. Non-production deployments are never
 * indexable; thin/low-sample/filtered/sample pages are noindex,follow.
 */
export function robotsFor(indexable: boolean): Metadata["robots"] {
  if (serverEnv().FOREVERDB_DEPLOYMENT !== "production") return { index: false, follow: false };
  return indexable ? { index: true, follow: true } : { index: false, follow: true };
}
