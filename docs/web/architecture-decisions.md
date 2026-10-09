# ForeverDB Web — architecture decision records

Status key: **Accepted** = implemented on `web/foundation-mvp`. **Proposed** = design ready, needs owner approval or infrastructure.

```
 PRIVATE (existing)                         ONE-WAY                          PUBLIC (new, isolated)
 ┌──────────────────────────┐   read-only   ┌───────────────────┐  insert   ┌───────────────────────────┐
 │ Production Supabase      │──────────────▶│ Publication worker│──────────▶│ Public read DB            │
 │  installation_* tables   │ projection_   │  allowlist+zod    │ publisher │  pub.* (versioned)        │
 │  guildbook, auth, budgets│ reader role   │  sanitize, thresh.│  role     │  web_api.* (bounded fns)  │
 │  publication_export.* fns│ (0010)        │  fail-closed, hash│ (RLS)     │  pub_admin.* (publisher)  │
 └──────────────────────────┘               └───────────────────┘           └─────────────┬─────────────┘
        ▲ Companion (JWT, 0009 budgets)                                                 │ web_reader role
        │ — unchanged —                                                 EXECUTE web_api.* only, 2–3 s timeouts
                                                                                          ▼
                                 Browser ──HTTPS──▶ CDN/WAF ──▶ Next.js (proxy: CSP nonce, rate limits) ──▶ BFF / RSC
```

## ADR-001 — Physically separate public read database (Accepted design; DB provisioning Proposed)

**Decision.** The website reads only from a separate Postgres database: a new Supabase project with the Data API disabled, or any managed Postgres. It is fed by a one-way publication pipeline. It holds only allowlisted aggregates.

**Why.** The private DB holds installation, Guildbook, diagnostics and security data (F-1). Sharing it would couple website traffic to Companion budgets and widen the blast radius of any website bug to private data.

**Trade-offs.** Data on the site lags production by one publication interval. It adds one more database to run, which costs little (a free or small tier is enough for the current ~1–2k rows). Until the project exists, the site runs on the labelled fixture adapter (ADR-007).

## ADR-002 — Publication pipeline: pull export → validate → versioned atomic swap (Accepted)

- A new production schema `publication_export` (migration **0010, prepared, not applied**) exposes 6 `SECURITY DEFINER` functions. They return only aggregates and re-quantized coordinates. They are executable only by the `foreverdb_projection_reader` role (read-only, no table grants).
- The worker (`publisher/`) parses every row with **strict** zod schemas. An unknown column fails the run. It then sanitizes names, applies thresholds, computes Wilson intervals and confidence, and builds a deterministic projection with a SHA-256 content hash.
- It writes a new `staging` publication and calls `pub_admin.finalize_publication` **in one transaction**. Finalize checks row counts, referential integrity, the denominator invariant, empty and >50 % shrink guards, and the duplicate hash, then swaps `pub.state.active_publication_id`. Any failure rolls back, and readers keep the previous version.
- Idempotent: an identical hash is a no-op. Auditable: `pub.publications` plus the append-only `pub.audit_log`. Retention: the last 3 publications, with instant operator rollback through `pub_admin.activate_publication`.
- Incremental: **full snapshot rebuild** was chosen deliberately at the current size (<2k rows). Revisit when the projection exceeds ~1M rows.
- No path writes back to production. The worker has no production write rights.

## ADR-003 — No Supabase Auth or PostgREST for public browsing (Accepted)

Browsers never get a database key or JWT. All data flows through server code (RSC pages and `/api/v1/*`) using a least-privilege Postgres role over TLS. The public DB's Data API should be **disabled**, and the migration also revokes everything from `anon`/`authenticated`. This removes "unlimited anonymous identities" from the public path entirely.

## ADR-004 — Next.js 16 App Router + TypeScript + Tailwind 4, inside this repo (Accepted)

- Server Components give indexable HTML. Route handlers act as the BFF. The `proxy` (formerly middleware) applies the nonce CSP and rate limits. `web/` sits next to `publisher/` and `database/public-read/` in this repository so contracts change atomically in one PR.
- Pinned exact versions and committed lockfiles: Next **16.3.8**, React **19.2.8**, zod **3.25.76**, pg **8.23.1**. `gray-matter` was replaced by `yaml` (core schema) after `npm audit` flagged its transitive dependencies. Prod `npm audit`: 0 vulnerabilities.
- Self-hosted OFL fonts (Cinzel, Inter, JetBrains Mono via Fontsource). No third-party runtime requests.

## ADR-005 — Strict nonce CSP ⇒ dynamic HTML; caching at the data layer (Accepted)

A per-request nonce with `'strict-dynamic'` and no `unsafe-inline` or `unsafe-eval` for scripts is incompatible with shared HTML caching: a cached nonce becomes a static, readable token. So HTML pages are rendered dynamically with `Cache-Control: private, no-store`, and caching moves to:

1. an in-process TTL cache (60 s, 2k keys) in front of the adapter, keyed by validated, normalized parameters;
2. `/api/v1/*` JSON, which carries no cookies, is shared-cacheable (`s-maxage=300, stale-while-revalidate=600`) and strictly validated (unknown params → 400) to resist cache poisoning;
3. the public DB, which is small, indexed and bounded by 2–3 s timeouts.

**Revisit** when traffic justifies CDN HTML caching. Options then: hash-based CSP for fully static routes, or ISR for article pages. Accepted cost: a little more server CPU per page view.

## ADR-006 — Layered abuse protection (Accepted in code; edge/WAF Proposed)

The app counts per hashed IP, per anonymous session cookie and per route globally, in **one Upstash Redis REST pipeline** (distributed, serverless-safe). Over-limit requests get HTTP 429 with `Retry-After` and `no-store`. Above a soft threshold, unverified clients get a progressive Cloudflare Turnstile challenge, verified server-side, which yields an HMAC, IP-bound, 30-min pass cookie. If the store is down, APIs fail closed (503) and HTML fails open (still behind the WAF, DB timeouts and caches). Production refuses to boot with the memory limiter. Budgets and capacity are in `api-contract.md`. Edge and WAF rules are platform configuration (`infrastructure-setup.md`) and are **not claimed active**.

## ADR-007 — Explicitly labelled fixture adapter until the public DB exists (Accepted)

`FixtureAdapter` serves a projection that the **real publisher** builds from **synthetic** test inputs (`database/tests/fixtures/`). Every page shows a non-dismissable banner, the API reports `"dataset":"synthetic-sample"`, all pages are `noindex`, and `env.ts` refuses `fixture` in production. The same E2E suite passes against the fixture adapter **and** against the Postgres adapter reading the real `web_api` schema, which is the parity evidence.

## ADR-008 — Git-managed Markdown editorial content (Accepted)

`web/content/{news,guides,blog}/*.md` holds YAML front matter (strict zod schema: status, sample flag, cover attribution, related entities) and Markdown rendered by `react-markdown`. Raw HTML is skipped, there is no MDX or JS, only http(s) and relative links are allowed, and images are limited to `/content-images/`. Publishing goes through a reviewed PR, so there is no public admin surface. Drafts are visible only in local development. Sample articles are labelled and `noindex`. The RSS feed is `/news/rss.xml`. A role-protected CMS can replace the loader later without touching the pages.

## ADR-009 — Type-aware canonical routes (Accepted)

`/item/{id}`, `/creature/{id}#level-{n}`, `/object/{id}` (negative IDs are synthetic fishing pools, whose IDs are never displayed), `/fishing/{uiMapID}`, `/zone/{uiMapID}`. Item-backed disenchant sources render on `/item/{id}#disenchants-into`. The source type is in the path, so `(source_type, source_id, source_level)` cannot collide. Levels are separate sections and are never merged.

## ADR-010 — Future accounts are a separate system (Proposed)

The public site has no login. Future registered accounts must use verified identity: a provider or email, never the anonymous JWT. Account→installation ownership must be proven (a claim code shown in the Companion, signed by the installation's session), never inferred from a known installation or guild ID. Account features go behind a separate authenticated origin or route group with `private, no-store` and its own threat review. Higher registered-user quotas use a separate reserved pool. None of this is implemented, and no private data is exposed.
