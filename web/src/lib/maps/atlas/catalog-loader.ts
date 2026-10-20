import { ALLOWED_ASSET_HOSTS } from "../asset-url";
import { parseAtlasIndex, type AtlasIndex, type AtlasMap } from "./schema";

/** The resolved catalog the website works from. `source` says honestly where it came from. */
export interface AtlasCatalog {
  source: "cdn" | "snapshot";
  build: string | null;
  maps: readonly AtlasMap[];
  byId: ReadonlyMap<number, AtlasMap>;
}

export interface LoaderOptions {
  /** Normalised https CDN base (e.g. https://azerdex-assets.pages.dev) or null: no CDN configured => snapshot only. */
  base: string | null;
  snapshot: unknown;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Fresh-for window (ms). */
  ttlMs?: number;
  /** After a failed fetch, do not retry for this long (ms): a slow/blocked CDN must not slow every page. */
  failureBackoffMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULTS = { ttlMs: 5 * 60_000, failureBackoffMs: 30_000, timeoutMs: 2_500, maxBytes: 2 * 1024 * 1024 };

function toCatalog(index: AtlasIndex, source: AtlasCatalog["source"]): AtlasCatalog {
  const maps = [...index.maps].sort((a, b) => a.uiMapId - b.uiMapId);
  return { source, build: index.currentBuild.version, maps, byId: new Map(maps.map((m) => [m.uiMapId, m])) };
}

/** Only ever fetches `<allow-listed https origin>/atlas/index.json`: the URL is built from a validated origin, never from data. */
export function atlasIndexUrl(base: string | null): string | null {
  if (!base) return null;
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== "https:" || u.port || u.username || !ALLOWED_ASSET_HOSTS.includes(u.hostname)) return null;
  return `${u.origin}/atlas/index.json`;
}

/**
 * Shared, bounded, validated catalog loader.
 *  - CDN catalog when reachable and valid (https, allow-listed host, no redirects, size cap, timeout, strict schema + cross-checks);
 *  - last good CDN catalog while it is stale and the CDN is failing (stale-if-error);
 *  - otherwise the bundled, verified snapshot. It never throws and never blocks a page for longer than `timeoutMs`.
 * Concurrent callers share one in-flight request; a failure is remembered for `failureBackoffMs`.
 */
export function createAtlasCatalogLoader(opts: LoaderOptions): () => Promise<AtlasCatalog> {
  const o = { ...DEFAULTS, ...opts };
  const now = o.now ?? Date.now;
  const f = o.fetchImpl ?? fetch;
  const parsedSnapshot = parseAtlasIndex(o.snapshot);
  if (!parsedSnapshot.ok) throw new Error(`bundled atlas snapshot is invalid: ${parsedSnapshot.error}`);
  const snapshot = toCatalog(parsedSnapshot.index, "snapshot");
  const url = atlasIndexUrl(o.base);

  let good: { at: number; catalog: AtlasCatalog } | null = null;
  let failedAt = -Infinity;
  let inflight: Promise<AtlasCatalog | null> | null = null;

  async function fetchCdn(): Promise<AtlasCatalog | null> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
    try {
      const res = await f(url!, { signal: ctl.signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > o.maxBytes) return null;
      const text = await res.text();
      if (text.length > o.maxBytes) return null;
      const parsed = parseAtlasIndex(JSON.parse(text));
      return parsed.ok ? toCatalog(parsed.index, "cdn") : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return async () => {
    if (!url) return snapshot;
    const t = now();
    if (good && t - good.at < o.ttlMs) return good.catalog;
    if (t - failedAt < o.failureBackoffMs) return good?.catalog ?? snapshot;
    inflight ??= fetchCdn().finally(() => { inflight = null; });
    const fresh = await inflight;
    if (fresh) { good = { at: now(), catalog: fresh }; return fresh; }
    failedAt = now();
    return good?.catalog ?? snapshot;
  };
}
