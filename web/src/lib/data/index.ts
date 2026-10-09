import "server-only";
import { serverEnv } from "../env";
import { FixtureAdapter } from "./fixture-adapter";
import { PostgresAdapter } from "./postgres-adapter";
import type { PublicDataAdapter } from "./types";

/**
 * Small in-process TTL cache in front of the adapter. Public data changes only
 * when a new publication is activated, so a short TTL bounds staleness while
 * absorbing repeated identical requests (e.g. crawlers re-hitting a page).
 * Keys are built from validated, normalized parameters only.
 */
class TtlCache {
  private store = new Map<string, { at: number; value: Promise<unknown> }>();
  constructor(private ttlMs: number, private max: number) {}
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    // Never cache failures.
    value.catch(() => this.store.delete(key));
    this.store.set(key, { at: now, value });
    if (this.store.size > this.max) this.store.delete(this.store.keys().next().value as string);
    return value;
  }
}

function cached(inner: PublicDataAdapter): PublicDataAdapter {
  const c = new TtlCache(60_000, 2_000);
  const k = (name: string, args: unknown[]) => `${name}:${JSON.stringify(args)}`;
  return {
    mode: inner.mode,
    meta: () => c.get(k("meta", []), () => inner.meta()),
    search: (q) => c.get(k("search", [q]), () => inner.search(q)),
    item: (id) => c.get(k("item", [id]), () => inner.item(id)),
    source: (t, id) => c.get(k("source", [t, id]), () => inner.source(t, id)),
    zones: () => c.get(k("zones", []), () => inner.zones()),
    zone: (id) => c.get(k("zone", [id]), () => inner.zone(id)),
    zoneEntities: (q) => c.get(k("zoneEntities", [q]), () => inner.zoneEntities(q)),
    recent: (n) => c.get(k("recent", [n]), () => inner.recent(n)),
    sitemap: (e, o, l) => c.get(k("sitemap", [e, o, l]), () => inner.sitemap(e, o, l)),
  };
}

let adapter: PublicDataAdapter | null = null;

export function data(): PublicDataAdapter {
  if (adapter) return adapter;
  const env = serverEnv();
  const inner = env.FOREVERDB_DATA_SOURCE === "postgres"
    ? new PostgresAdapter(env.PUBLIC_READ_DATABASE_URL!)
    : new FixtureAdapter();
  adapter = cached(inner);
  return adapter;
}
