# ForeverDB Web — Vercel environments, deployment protection and release controls

Status of this document: **PREVIEW HARDENED (code) / production still BLOCKED.** Written for the PR `web/vercel-preview-hardening`. Nothing here enables production mode, provisions the public database, or publishes real observations.

## 1. Architecture decisions this document implements

1. **Two physically separate databases.** *Private Supabase `wow-forever`* holds Companion ingestion, authentication, installation ownership, Guildbook and future account-bound data. The *public PostgreSQL* (not yet provisioned) holds sanitised, approved aggregates only.
2. The **public website never receives credentials for the private database** (enforced in `web/src/lib/env.ts`, the bundle-secret scan and CI).
3. **Public loot search stays anonymous.** Future registration/login (Account System V1, next milestone) uses the existing private Supabase Auth through a separately reviewed boundary; it is not part of this change and must not make public browsing depend on login.
4. The private Supabase project is production-only and was treated as **read-only** for this work (no query was run against it).

## 2. The three environments

| | Local | Protected preview | Future production |
| --- | --- | --- | --- |
| `FOREVERDB_DEPLOYMENT` | `local` (default only off-Vercel) | `preview` (explicit) | `production` (explicit) |
| Data | synthetic fixture | synthetic fixture (labelled banner) or a *public* read DB | only the separate **public PostgreSQL** (`foreverdb_web_reader`) |
| Rate limiter | memory | memory (per instance) | **Upstash** (distributed) |
| Indexing | `noindex, nofollow` | `noindex, nofollow` (HTML **and** API, `robots.txt` disallow-all, empty sitemap) | indexable; `robots.txt` + sitemap |
| URL | `localhost` only | https; derived from Vercel metadata if `SITE_URL` unset | explicit https `SITE_URL` equal to the Vercel production domain |
| Access | developer | **Vercel Deployment Protection** | public, behind app limits, WAF, Upstash, Turnstile (optional) |
| Credentials | none | none that reach production | public-DB reader, Upstash, salt, trusted-IP header |

### Fail-closed rules (all covered by `web/tests/unit/env-matrix.test.ts` and `web/tests/e2e/preview-safety.spec.ts`)

- A **hosted** deployment (`VERCEL=1`, or `VERCEL_ENV` of `production`/`preview`) **never falls back to `local`**: a missing or `local` `FOREVERDB_DEPLOYMENT` is rejected, and `FOREVERDB_DATA_SOURCE` must be explicit. `vercel dev` (`VERCEL_ENV=development`) counts as a developer machine.
- **Vercel's "production" target is not ForeverDB production.** The temporary synthetic demonstration is served through the production alias and must say `FOREVERDB_DEPLOYMENT=preview`. The reverse is rejected: `FOREVERDB_DEPLOYMENT=production` is only valid when `VERCEL_ENV=production`.
- `production` refuses the fixture adapter, the memory limiter, a missing trusted-IP header or salt, an `http` URL, and a `SITE_URL` that differs from `VERCEL_PROJECT_PRODUCTION_URL`.
- Any `postgres` data source must be the `foreverdb_web_reader` role and must **not** reference the private project (`klxhikdlfwgxurdyexdi`; matched case-insensitively and after percent-decoding); a local address (any spelling: `localhost.`, `0x7f.1`, `[::ffff:7f00:1]`, `[::]`, private/link-local ranges) is rejected on hosted deployments.
- On any hosted/designated deployment, variables named `SUPABASE*`, `*SERVICE_ROLE*`, `DATABASE_URL`, `POSTGRES_URL*` are rejected, and application variables whose value references the private project are rejected. (Account System V1 will relax this deliberately, behind its own review.)
- `SITE_URL` on a hosted deployment must be https, not credentialed, not localhost/private; preview derives its own origin from `VERCEL_BRANCH_URL`/`VERCEL_URL` (or the production alias for the temporary demo).
- `TRUSTED_IP_HEADER` unset defaults to `x-real-ip` on Vercel (the platform overwrites it); an explicit `none` is rejected on hosted deployments (it would put every visitor in one rate-limit bucket); `cf-connecting-ip` is rejected on Vercel (not set by the platform, so client-spoofable).
- Error messages name **variables only**, never values. The reason a configuration is refused is logged server-side; the response is a generic HTTP 500 and `robots.txt` also refuses, so a refused deployment can never be indexed.
- Every response **that passes through the proxy** (all pages, all `/api/*` including 4xx/429/503) carries `X-ForeverDB-Deployment: <designation>`; non-production ones also carry `X-Robots-Tag: noindex, nofollow`. The proxy matcher deliberately **excludes** `_next/static`, `_next/image`, `fonts/`, `favicon.ico`, `icon.svg`, `robots.txt` and `sitemap.xml` (cookie-free, cacheable assets): those carry only the static security headers from `next.config.ts`, and `robots.txt`/`sitemap.xml` express non-indexability in their *content* (disallow-all, empty). A refused configuration answers a bare HTTP 500 with no headers by design. The HTML carries `<meta name="foreverdb-deployment">`, so a preview cannot be mistaken for a release at the HTTP level. The session cookie is `__Host-` + `Secure` whenever the real origin is https.

## 3. Environment-variable matrix

Only the first two are required for the temporary demonstration; both are **non-secret**.

| Variable | Local | Preview (branch previews) | Temporary demo (Vercel *Production* target) | Future production |
| --- | --- | --- | --- | --- |
| `FOREVERDB_DEPLOYMENT` | *(unset → local)* | **`preview`** | **`preview`** | `production` |
| `FOREVERDB_DATA_SOURCE` | *(unset → fixture)* | **`fixture`** | **`fixture`** | `postgres` |
| `SITE_URL` | *(default localhost)* | leave unset (derived) | leave unset (derived from the production alias) or `https://wow-foreverdb.vercel.app` | **explicit** `https://<production domain>` |
| `TRUSTED_IP_HEADER` | `none` | unset (defaults to `x-real-ip` on Vercel) | unset (defaults to `x-real-ip` on Vercel) | `x-real-ip` (**required**, explicit) |
| `RATE_LIMIT_SALT` | optional | recommended (32+ random bytes) | recommended | **required** |
| `RATE_LIMIT_BACKEND` | `memory` | `memory` | `memory` | `upstash` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | unset | unset | unset | **unset until Upstash is provisioned and reviewed** |
| `PUBLIC_READ_DATABASE_URL` | unset | unset | unset | **unset until the public DB exists** |
| `TURNSTILE_*`, `CHALLENGE_COOKIE_SECRET`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | unset | unset | unset | optional, after review |
| Any `SUPABASE*`, `*SERVICE_ROLE*`, `DATABASE_URL`, `POSTGRES_URL*` | never | never | never | never |

Future-production secrets (public-DB URL, Upstash token, salt, challenge secrets) **must stay unset** until their infrastructure and security reviews are complete. `FOREVERDB_DEPLOYMENT=production` must not be set by anyone until `docs/web/go-live-checklist.md` sections A–C are all ✅.

### Owner steps (the Vercel connector used for this work cannot read or write environment variables — HTTP 403 on both)

Do these **before merging** the hardening PR (new code refuses to serve a hosted deployment without them):

1. Vercel → project `wow-foreverdb` → Settings → Environment Variables.
2. Add `FOREVERDB_DEPLOYMENT` = `preview` for **Production** and **Preview**.
3. Add `FOREVERDB_DATA_SOURCE` = `fixture` for **Production** and **Preview**.
4. `TRUSTED_IP_HEADER` needs no action: on Vercel it defaults to `x-real-ip`. Do **not** set it to `none`.
5. CLI equivalent: `vercel env add FOREVERDB_DEPLOYMENT production` (value `preview`), then `preview`; same for `FOREVERDB_DATA_SOURCE` (value `fixture`). Variables apply to **new** deployments only: redeploy afterwards.
6. Verify (step 8 below).

These variables are backward compatible with the code currently on `main` (a `preview` designation with fixture data behaves like today's mode and additionally fixes the cookie flag), so setting them first is safe.

## 4. Node.js decision: **22.x**

| Place | Before | After |
| --- | --- | --- |
| GitHub CI (web, publisher) | `22` (hard-coded) | `.node-version` = `22` (single source) |
| `package.json` engines (web, publisher) | `>=22` (Vercel warns it "will automatically upgrade when a new major Node.js Version is released") | `22.x` |
| Vercel runtime | **24.x** (dashboard setting; the live demo currently runs Node 24) | `22.x` via `engines` (Vercel gives `engines.node` precedence over the dashboard setting; Vercel does **not** read `.node-version`) |

Why 22: every verification run on this repository (unit, Playwright, publication pipeline, parity, CodeQL) ran on Node 22; `@types/node` is `22.x`; Next 16.4.0, React 19.3.0, Playwright 1.63.0 and the publisher support it; **no dependency was changed** to get here. Node 24 is a separate migration (a CI matrix PR and a dependency review) to be done before Node 22 leaves maintenance (April 2027). **Merging this change moves the live demo from Node 24 to Node 22** (a deliberate downgrade to the one version all evidence covers; Node 24 was never verified for this app). `.node-version` is the single source for **CI and developers**; **Vercel follows `engines`**, so the two are kept equal by a CI step that fails if the running major, `.node-version` and the `engines` of **both** `web` and `publisher` disagree. Optional owner step: also set Settings → General → Node.js Version to `22.x` so the dashboard agrees. **Verified on Vercel (2026-10-10, preview build of this branch):** the build log reads *"Due to `engines: { node: 22.x }` in your `package.json` file, the Node.js Version defined in your Project Settings (\"24.x\") will not apply, Node.js Version \"22.x\" will be used instead."* The old `>=22` warning ("will automatically upgrade when a new major Node.js Version is released") is gone. The production build after the merge should show the same line.

## 5. Deployment protection policy

| Surface | Policy | Mechanism | Status |
| --- | --- | --- | --- |
| Branch/PR previews | **Not publicly accessible** | Vercel Authentication (SSO), applies to all previews | Configured (`ssoProtection: all_except_custom_domains`) |
| Temporary synthetic demo (`wow-foreverdb.vercel.app`, no custom domain) | Intended: protected. **Not verified: it may be publicly reachable.** Either way it is labelled (banner) and non-indexable (header, meta, `robots.txt`, empty sitemap) and holds only synthetic data | `ssoProtection: all_except_custom_domains` is configured, but on Hobby the production `.vercel.app` alias may fall outside that scope; only the external test below can tell | **PENDING: unauthenticated external access test** (see below). If it turns out to be public, the content is synthetic and clearly labelled; decide whether to keep it public as a demo or restrict it |
| Future production | Public, hardened | App limits (Upstash), WAF rules, Attack Challenge Mode, Turnstile (optional) | Not provisioned |

**Important caveat of `all_except_custom_domains`:** once a **custom domain** is attached to the production environment it becomes **publicly reachable without Vercel login**. Do not attach a custom domain for the synthetic demo. Attach one only as part of the production go-live, after the checklist passes.

The project flag is **not** treated as proof. `web/scripts/verify-deployment.mjs <url> --expect protected` performs the unauthenticated test and fails on any 2xx, any ForeverDB cookie/header, or any application content. **It must be run from a machine outside the connector's sandbox** (this work's sandbox cannot resolve or tunnel to `*.vercel.app`: DNS failure / HTTP 403 from the egress policy), so the result for the production alias, a branch URL, `/api/v1/meta` and the search API is **PENDING**, not PASS:

```bash
cd web
node scripts/verify-deployment.mjs https://wow-foreverdb.vercel.app --expect protected
node scripts/verify-deployment.mjs https://<branch-preview-host>.vercel.app --expect protected
# with the automation-bypass secret in an env var (never on the command line):
VERCEL_AUTOMATION_BYPASS_SECRET=... node scripts/verify-deployment.mjs https://wow-foreverdb.vercel.app --expect preview --bypass-env VERCEL_AUTOMATION_BYPASS_SECRET
```

Hosting-plan notes (Hobby): the available firewall features, log retention (1 hour) and spend controls depend on the plan. Nothing is claimed active that was not observed: **no custom firewall configuration exists** (the active-config API returns 404), so WAF rules, Attack Challenge Mode and a rate-limit rule are **not active**. Supported alternative until a plan upgrade: the application limiter (per IP/session/global) plus Vercel's platform-level DDoS mitigation. Check Billing for the plan's usage limits; no billing change was made.

## 6. Production-promotion control

Today `main` auto-deploys to the Vercel **Production** target, so any merge reaches the public alias. With the variables above it serves the protected, noindexed synthetic demo, which is acceptable. It stops being acceptable once **incomplete features** (Account System V1) land on `main`.

Recommended control (prepared, **not applied — needs owner approval**, it changes the production deployment flow):

1. Create a protected branch `release`. Vercel → Settings → Git → **Production Branch** = `release`.
2. `main` pushes then build **previews only**; the production alias moves only when the owner fast-forwards `release` after the release gates (`docs/web/release-gates.md`) and the go-live checklist pass.
3. Rollback: Vercel Instant Rollback to the previous production deployment, or move `release` back.
4. Do this **before** the first Account System V1 commit is merged.

Until then: never set `FOREVERDB_DEPLOYMENT=production`; keep the future-production secrets unset.

## 7. Observed state before this change (2026-10-10)

| Finding | Evidence |
| --- | --- |
| Vercel project `wow-foreverdb` (Next.js, Hobby plan, GitHub-linked, root directory `web`, Node 24.x) | Vercel API, build log |
| Production-target deployment READY from `main` | Vercel API |
| Environment variables | **Could not be read** (HTTP 403 scoped and unscoped); the earlier "none configured" is unverified. Behaviour implies none: the live site ran as `local` |
| Live canonical link was `http://localhost:3000` | authenticated fetch of the live page |
| Live `fdb_sid` cookie had **no `Secure` flag** (`SameSite=Lax; HttpOnly`) on an https site | live response headers |
| Security headers present: nonce CSP with `strict-dynamic`, HSTS, `nosniff`, `X-Frame-Options: DENY`, no-store | live response headers |
| `X-Robots-Tag: noindex, nofollow` and synthetic banner present | live response |
| No custom firewall config; runtime logs readable only for the last hour (Hobby) | Vercel API (the earlier "insufficient permissions" was the retention window) |
| Team-scoped API calls: project/deployment/domain reads succeed; environment-variable and firewall-config access is refused | Vercel API |

The canonical and cookie defects are direct consequences of the silent `local` fallback and are fixed by this change (explicit designation, https-derived origin, `__Host-`/`Secure` cookie keyed to the real origin).

## 8. Live fail-closed evidence on Vercel (2026-10-10)

The preview deployments of this branch were built **before** the owner variables exist. They are therefore a real-platform test of the refusal: the preview of commit `5d0086f` (`dpl_2ojaHek5MocYKcnUuQ4Sp7XEMNBf`) answers **HTTP 500, body `Internal Server Error`, no application content, no ForeverDB cookie or header** (only platform headers, including Vercel's own `x-robots-tag: noindex`). That also shows the Preview target currently has no `FOREVERDB_DEPLOYMENT`. Once the owner sets the variables and redeploys, the same URL must serve the synthetic preview (section 9).

## 9. Verification after the owner steps

```bash
# 1. the PR's preview (or any deployment) reports the designation:
curl -sI https://<deployment-host>/api/v1/meta | grep -i x-foreverdb-deployment   # preview
# 2. protected (from outside), see section 5
# 3. preview behaviour with the bypass secret, see section 5
# 4. production build log no longer shows the Node ">=22" engines warning
```

Expected for the demo: `X-ForeverDB-Deployment: preview`, `X-Robots-Tag: noindex, nofollow`, canonical on `https://wow-foreverdb.vercel.app`, cookie `__Host-fdb_sid` with `Secure`.
