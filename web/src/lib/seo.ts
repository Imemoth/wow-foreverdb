import "server-only";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { data } from "./data";
import { isIndexable, serverEnv, type ServerEnv } from "./env";

/**
 * Legacy public-beta SEO eligibility helpers. The production site is now live, so
 * PUBLIC_BETA_INDEXING_ENABLED disables their indexing override even when the old
 * host/branch/publication authorization conditions are still satisfied.
 */
export const BETA_SEO_HOSTNAME = "beta.azerdex.com";

/** Production is live: the former public-beta indexing exception is permanently disabled. */
export const PUBLIC_BETA_INDEXING_ENABLED = false;

type BetaSeoEnv = Pick<ServerEnv, "FOREVERDB_DEPLOYMENT" | "FOREVERDB_DATA_SOURCE" | "betaSeoBranchAuthorized">;

/**
 * Request hostname, lowercased, with any port stripped. Resolves to "" (never eligible for the
 * beta exception) outside a real request scope - e.g. a direct unit-test call to robots()/sitemap() -
 * so a missing request context fails closed instead of throwing or guessing.
 */
export async function requestHostname(): Promise<string> {
  try {
    const h = await headers();
    return (h.get("host") ?? "").split(":")[0]!.toLowerCase();
  } catch {
    return "";
  }
}

/** Host/mode/data-source/branch conditions shared by robots.txt and sitemap.xml, which have no path of their own. */
export function isPublicBetaHost(env: BetaSeoEnv, hostname: string): boolean {
  return (
    hostname.toLowerCase() === BETA_SEO_HOSTNAME &&
    env.FOREVERDB_DEPLOYMENT === "preview" &&
    env.FOREVERDB_DATA_SOURCE === "postgres" &&
    env.betaSeoBranchAuthorized
  );
}

/** The synchronous allow-list: isPublicBetaHost plus the exact homepage path. */
export function isPublicBetaHomepage(env: BetaSeoEnv, hostname: string, pathname: string): boolean {
  return pathname === "/" && isPublicBetaHost(env, hostname);
}

/**
 * True only while the public database answers with a genuine active publication (dataset
 * "published", a publication id and a publication time). Any failure - database unreachable,
 * no active publication - is "false": the beta then stays noindex instead of advertising a site
 * with no real data. Backed by the adapter's 60 s cache, so it costs at most one cheap meta()
 * call per minute per instance.
 */
export async function hasGenuinePublication(): Promise<boolean> {
  try {
    const m = await data().meta();
    return m.mode === "published" && m.publicationId != null && m.publishedAt != null;
  } catch {
    return false;
  }
}

/** isPublicBetaHost + the genuine-publication check (robots.txt / sitemap.xml). */
export async function isIndexablePublicBetaHost(env: BetaSeoEnv, hostname: string): Promise<boolean> {
  return PUBLIC_BETA_INDEXING_ENABLED && isPublicBetaHost(env, hostname) && (await hasGenuinePublication());
}

/** isPublicBetaHomepage + the genuine-publication check (HTML metadata, X-Robots-Tag, JSON-LD). */
export async function isIndexablePublicBetaHomepage(env: BetaSeoEnv, hostname: string, pathname: string): Promise<boolean> {
  return PUBLIC_BETA_INDEXING_ENABLED && isPublicBetaHomepage(env, hostname, pathname) && (await hasGenuinePublication());
}

/**
 * Single source of truth for indexing. Production-only indexing; the former beta
 * homepage exemption is disabled after public launch. Thin-content pages are noindex,follow.
 */
export function robotsFor(indexable: boolean, betaHomepage = false): Metadata["robots"] {
  if (betaHomepage && PUBLIC_BETA_INDEXING_ENABLED) return { index: true, follow: true };
  if (!isIndexable(serverEnv())) return { index: false, follow: false };
  return indexable ? { index: true, follow: true } : { index: false, follow: true };
}
