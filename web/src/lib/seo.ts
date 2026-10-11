import "server-only";
import type { Metadata } from "next";
import { isIndexable, serverEnv } from "./env";

/**
 * Single source of truth for indexing. Non-production deployments are never
 * indexable; thin/low-sample/filtered/sample pages are noindex,follow.
 */
export function robotsFor(indexable: boolean): Metadata["robots"] {
  if (!isIndexable(serverEnv())) return { index: false, follow: false };
  return indexable ? { index: true, follow: true } : { index: false, follow: true };
}
