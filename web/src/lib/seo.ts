import "server-only";
import { headers } from "next/headers";
import type { Metadata } from "next";
import { isIndexable, serverEnv, type ServerEnv } from "./env";

/**
 * Narrowly-scoped public-beta homepage SEO exception. Google may index ONLY the exact homepage
 * ("/") of this exact hostname, on a preview deployment serving fixture data, whose branch has
 * been explicitly authorized (env.ts's betaSeoBranchAuthorized). Every other beta page, every
 * generated *.vercel.app alias and every other branch stays governed by isIndexable() below
 * (production only) - this is an allow-list of five independent conditions, not a default that
 * any single one of them can imply on its own.
 */
export const BETA_SEO_HOSTNAME = "beta.azerdex.com";

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
    env.FOREVERDB_DATA_SOURCE === "fixture" &&
    env.betaSeoBranchAuthorized
  );
}

/** The full five-condition allow-list: isPublicBetaHost plus the exact homepage path. */
export function isPublicBetaHomepage(env: BetaSeoEnv, hostname: string, pathname: string): boolean {
  return pathname === "/" && isPublicBetaHost(env, hostname);
}

/**
 * Single source of truth for indexing. Non-production deployments are never indexable, except the
 * one narrowly-scoped public-beta homepage (pass betaHomepage from isPublicBetaHomepage above);
 * thin/low-sample/filtered/sample pages are noindex,follow.
 */
export function robotsFor(indexable: boolean, betaHomepage = false): Metadata["robots"] {
  if (betaHomepage) return { index: true, follow: true };
  if (!isIndexable(serverEnv())) return { index: false, follow: false };
  return indexable ? { index: true, follow: true } : { index: false, follow: true };
}
