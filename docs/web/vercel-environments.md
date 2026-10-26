# ForeverDB Web — Vercel environments, deployment protection and release controls

> **2026-10-12 draft Account V1 candidate only:** A separate server-side Account Auth/RPC boundary may **eventually** use the existing private Supabase HTTPS gateway in a protected owner-only pilot or separately approved production release. This is **not** a public-data connection and does not relax the `AZERDEX_READ_DB_URL` or `NEXT_PUBLIC_*` isolation rules. Both code approval flags remain OFF and no Vercel/production activation has occurred. See [the Account V1 single-project runbook](../account-v1/single-project-candidate.md). The public-site architecture below remains binding.


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
| `TRUSTED_IP_HEADER` | `none` | unset (defaults to `x-real-ip` on Vercel) | unset (defaults to `x-real-ip` on Vercel) | `x-real-ip` (defaults on Vercel; set it explicitly as a deliberate act) |
| `RATE_LIMIT_SALT` | optional | recommended (32+ random bytes) | recommended | **required** |
| `RATE_LIMIT_BACKEND` | `memory` | `memory` | `memory` | `upstash` |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | unset | unset | unset | **unset until Upstash is provisioned and reviewed** |
| `AZERDEX_READ_DB_URL` | unset | unset | unset | **unset until the public DB exists** |
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

## 4. Node.js decision: **24.x**

The owner selected Node.js 24.x (2026-10-10). It is configured identically everywhere and enforced by CI.

| Place | Value | Mechanism |
| --- | --- | --- |
| GitHub CI (web, publisher, publish workflow) | `24` | `.node-version` = `24` (single source; every `setup-node` step uses `node-version-file`) |
| `package.json` engines (web, publisher) | `24.x` | Vercel gives `engines.node` precedence over the dashboard setting; Vercel does **not** read `.node-version` |
| Vercel dashboard (Settings → General → Node.js Version) | `24.x` | already set by the owner; `engines` agrees |
| `@types/node` (web, publisher) | `24.19.2` | matches the runtime major (was `22.20.5`); the only dependency change |

Compatibility basis (registry `engines` fields, 2026-10-10): Next 16.4.0 `>=20.9.0`, Playwright 1.63.0 `>=20`, `pg` 8.23.1 (no upper bound), vitest 3.2.7, TypeScript 5.9.3 (no runtime constraint), React 19.3.0 (no constraint). Measured evidence: the complete verification suite (lint, typecheck, unit, environment matrix, production build with canary secrets, bundle scan, Playwright desktop/mobile/preview, publisher unit, publication pipeline, Postgres-adapter E2E, parity) was re-run on **Node 24.21.0** from a clean `npm ci`; results are in `verification-results.md`. CI fails if the running major, `.node-version` and the `engines` of **both** `web` and `publisher` disagree, so Vercel and CI cannot drift apart again. Node 22 is no longer used anywhere in the repository. (`>=22` previously let Vercel float silently; `24.x` pins the major.)

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

**2026-10-11 snapshot:** the stable `release` branch was created from `6b49a3feb06651334ccb148abec47509b63aef88` (PR #45 squash merge; seven post-merge checks PASS). GitHub `main` is protected by ruleset #24853899; protection of `release` and Vercel Production Branch tracking are **PENDING owner configuration and independent verification**. The repository JSON is a configuration template, not an automatically applied ruleset.

### Required owner actions, in order

1. **Protect `release`:** GitHub → repository Settings → Rules → Rulesets → edit the existing [`main release gates`](https://github.com/Imemoth/wow-foreverdb/settings/rules/24853899). Under Target branches, preserve Default branch and add **Include by pattern: `release`** (API ref `refs/heads/release`). Keep Active, no bypass actors, required PR, force-push/deletion blocks, and the six required GitHub Actions checks pinned to integration ID `15368`. Save, then confirm the `release` branch reports `protected: true` and the active ruleset targets both branches. Do **not** import a duplicate ruleset.
2. **Change Vercel branch tracking:** project Settings → **Environments → Production → Branch Tracking** → choose `release` → Save. Vercel moved Production Branch tracking to Environments in its current UI; the older Settings → Git instructions may be stale. Verify the dashboard shows `release`, not `main`. This must happen **before any Account System V1 feature is merged to `main`**.
3. **Preserve the protected demonstration:** `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=fixture` for both Vercel Production and Preview targets, with Vercel Authentication **All Deployments**. The production *target* continues to serve a private, noindexed **synthetic Preview-mode demo**. No private Supabase variables, public database, or real publication must be enabled as part of branch tracking.
4. **Acceptance:** validate the production alias stays on the approved stable commit, READY and protected; a new `main` commit must produce a **Preview** deployment rather than replacing that alias. Confirm the source SHA/branch through Vercel Deployments and the actual Branch Tracking setting. A controlled docs-only PR can exercise this without releasing unfinished functionality.

### Future promotion and rollback

- Require an owner-reviewed PR **to `release`** with all six GitHub Actions checks passing. Do not push/force-move the protected branch directly. A promotion may use a reviewed release-candidate branch based on `release` with only approved changes cherry-picked from development.
- **Do not blindly merge the entire `main` branch into `release` once `main` contains unfinished features.** PR requirements and CODEOWNERS policies still apply to release candidates.
- Rollback uses **Vercel Instant Rollback**, or a reviewed revert PR to `release`; never bypass release-branch protection.
- Until separate production go-live approval: never set `FOREVERDB_DEPLOYMENT=production`; keep future production secrets unset. Account System V1 is developed in isolated PRs and Preview deployments.

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

## 10. Addendum (2026-10-20): the live `beta.azerdex.com` public-beta track

Everything above (sections 1–9) describes the state as of the 2026-10-10..12 hardening work, before `beta.azerdex.com` existed as an attached domain. Both are still true; this section adds what changed since, without rewriting the history above.

- **`beta.azerdex.com` is now an attached custom domain with an explicit, scoped Vercel Deployment Protection Exception** — not the blanket "custom domains bypass SSO" caveat warned about in §5 (that caveat was about *any* custom domain opening up unauthenticated access; the realized design instead keeps `all_except_custom_domains`-style protection as the default and carves out only this one domain, intentionally, for the public-beta track). Every other Preview deployment — branch previews, the bare `*.vercel.app` URLs, any other domain — remains behind Vercel Authentication exactly as §5 describes. This is **not** a change to `FOREVERDB_DEPLOYMENT`/`FOREVERDB_DATA_SOURCE` semantics: Vercel's deployment-protection exception is an *infrastructure* control (who can reach the deployment at all), independent of the *application* designation (`preview`/`fixture`) that `env.ts` itself validates and enforces — the two must not be conflated.
- **`beta.azerdex.com` serves `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=fixture`** — exactly the "Protected preview" row in §2's environment matrix, data-source- and designation-wise. The one thing that row's "Indexing" cell does not capture is the exception below.
- **Narrow homepage-only indexing exception**, implemented in `web/src/lib/seo.ts` (`isPublicBetaHomepage`) and gated by `web/src/lib/env.ts`'s `BETA_SEO_AUTHORIZED_BRANCH` (must equal the exact git branch serving the deployment, so a value copied to another branch's environment stays inert there): **only** `https://beta.azerdex.com/` — the bare homepage path, nothing else — is indexable (`index, follow`) when the deployment is simultaneously on the authorized branch, in `preview` mode, on `fixture` data, and exactly that hostname. Every other route on `beta.azerdex.com` (`/database`, `/zones`, `/guides`, `/news`, `/blog`, `/download`, `/account/*`, every entity/API path) stays `noindex, nofollow` exactly as §2's matrix already states for "Protected preview." `robots.txt` and `sitemap.xml` are adjusted to match (sitemap lists exactly the one authorized homepage URL; `robots.txt` otherwise disallows `/api/` and `/verify`). Verified live (public, unauthenticated smoke test, 2026-10-20): homepage served `meta name="robots" content="index, follow"` and canonical `https://beta.azerdex.com`; `/database`, `/zones`, `/guides`, `/news`, `/blog`, `/download`, `/account` all served `X-Robots-Tag: noindex, nofollow` and the matching meta tag.
- **Beta rate limiting (read-only Vercel verification, 2026-10-20):** unlike the older generic Preview default in §2/§3 (`memory`), the branch-scoped `web/azerdex-beta` Preview setting is `RATE_LIMIT_BACKEND=upstash`. Upstash Marketplace REST API variables and `RATE_LIMIT_SALT` are configured in the Preview environment; `env.ts` supports those aliases and fails closed on missing REST credentials. These settings confirm configuration, not a separately witnessed Redis request or completed Production rate-limiter acceptance. Other developer Preview branches have independent settings.
- **Production activation and real-data publication remain entirely separate, unapproved release operations** — this addendum changes nothing about §6's production-promotion control, the go-live checklist, or `FOREVERDB_DEPLOYMENT=production` staying blocked. The public beta is, and remains, a synthetic-fixture demonstration on the `preview` designation; see `docs/web/azerdex-roadmap.md` for the milestone ledger of what has shipped on this track (P1 through P2-E) versus what is still gated.

## 11. Addendum (2026-10-21): `beta.azerdex.com` on real published data (P2-Z3)

Supersedes the "synthetic-fixture demonstration" wording of §10 for the beta track once the integration PR is deployed: the beta then runs
`FOREVERDB_DEPLOYMENT=preview` + `FOREVERDB_DATA_SOURCE=postgres` with `AZERDEX_READ_DB_URL` (a *sensitive*, branch-scoped variable using the
`foreverdb_web_reader` role through the Supavisor transaction pooler) and never serves fixtures. The homepage-only indexing exception now requires
`postgres` (not `fixture`) **and** a genuine active publication, checked per request. Variables, verification and rollback:
[public-beta-release.md](public-beta-release.md). Production, `azerdex.com`, DNS, Cloudflare and other Preview branches are unchanged.

Status (2026-10-21): the beta is live on this configuration and P2-Z3 is closed; see the final status, root causes and remaining limitations in [public-beta-release.md](public-beta-release.md).
