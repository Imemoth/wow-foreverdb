# Release parity: beta vs production

A green build is **not** proof that an approved public feature is live. The talent icons and the rank descriptions are switched on by
Vercel variables (`AZERDEX_TALENT_ICONS=cdn`, `AZERDEX_TALENT_TEXT=1`) that no build validates: with them missing, `next build`
succeeds, the deployment is `READY`, and the feature is silently absent. That is exactly how production drifted from the beta.
This document defines the gate that closes that hole. Code: `web/scripts/lib/release-parity.mjs` (policy + evaluator),
`web/scripts/release-parity.mjs` (CLI), `web/tests/unit/release-parity.test.ts`, `.github/workflows/release-parity.yml`.

## Approvals

| Feature | Production value | Approval |
| --- | --- | --- |
| Talent icons (358 Blizzard spell icons from the asset CDN) | `AZERDEX_TALENT_ICONS=cdn` (**`cdn`, not `1`**: `src/lib/talents/icons.ts`) | Owner approved production publication, recorded 2026-11-02 |
| Talent rank descriptions (verified overlay, build 1.60.1.70634) | `AZERDEX_TALENT_TEXT=1` (`src/lib/talents/text.ts`) | Owner approved production publication, recorded 2026-11-02 |
| Zone maps | `AZERDEX_ZONE_MAPS=1` | Approved public functionality (parity with beta) |
| Zone hero art from the CDN | `AZERDEX_ZONE_HERO_SOURCE=cdn` | Approved public functionality (parity with beta) |
| Shared asset CDN host | `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev` (identical in beta and production) | Preserved |

These are implementation approvals, not a licence from Blizzard. The Blizzard attribution, ownership notices and the independent
fan-site disclaimer are unchanged (`docs/third-party-blizzard-content-notice.md`, site footer, `/about/data`).

## Classification

Every variable of the effective beta and production configuration lands in exactly one class:

| # | Class | Rule | Examples |
| --- | --- | --- | --- |
| 1 | **required-match** | Production must carry the exact value; beta must not drift from it. Missing, wrong, or unreadable (sensitive) = **fail**. `AZERDEX_TALENT_TEXT` is the one exception on the beta side: `talentTextPublished` publishes the text on every non-production designation, so the beta legitimately has **no** such variable and passes while its `FOREVERDB_DEPLOYMENT` is a readable `preview` (any explicit beta value must still be `1`). The other switches are explicit in both. | the four switches above, the asset host |
| 2 | **intentional** | Allowed to differ by design. Some carry pinned expectations. | `FOREVERDB_DEPLOYMENT` (production vs preview), `BETA_SEO_AUTHORIZED_BRANCH` (must not exist in production; must equal the beta branch in beta), `AZERDEX_READ_DB_URL`, `RATE_LIMIT_*`, `UPSTASH_*`, `TRUSTED_IP_HEADER`, `TURNSTILE_*`, `ACCOUNT_*`, preview feedback settings, `SITE_URL` |
| 3 | **requires-approval** | Third-party content with **no** recorded approval: must stay off in production. | `AZERDEX_POC_MAPS` |
| 4 | **unexpected** | Anything unclassified that differs (presence or value), and any forbidden name (`SUPABASE*`, `*SERVICE_ROLE*`, `DATABASE_URL`, `POSTGRES_URL*`) anywhere. **Fails** until classified or aligned. | |

Adding a variable that differs between environments therefore requires a deliberate classification in `release-parity.mjs`.
Platform `VERCEL_*` variables are ignored.

### Effective configuration

Resolved the way Vercel applies it, highest precedence first: **beta**: project variable bound to `web/azerdex-beta` > project
Preview-wide variable > shared (team) Preview variable; variables bound to another branch are ignored. **production**: project
variable targeting Production > shared variable; a variable bound to a git branch never counts as a production value.

### Build-time vs runtime

| Evaluation | Variables | Consequence |
| --- | --- | --- |
| build | `NEXT_PUBLIC_*` (inlined by `next build`) | A deployment built before the change keeps the old value |
| runtime | every other variable | Read by the server, but **only a deployment created after the variable was saved sees it**: saving a variable changes nothing for an existing deployment |

So a **previously promoted build cannot be reused**. With `--deployment`, the gate fails if any approved variable changed after the
deployment was created, if the deployment is not a production-target build, or (`--expect-sha`) if it was built from another commit.

### Secrets

The report contains variable **names**, classes and verdicts. A value appears only for the policy-public switches (the four flags,
the asset host, `FOREVERDB_DEPLOYMENT`). `decrypt` is never requested on the list call. Vercel stores a new variable as `encrypted` by default, so for the **policy-public keys only** (the four switches, the asset host, the designations) the value is read one variable at a time (`GET /v1/projects/{id}/env/{envId}`, the token must be allowed to read it); no other variable is ever decrypted, and a failed read leaves the variable opaque. A `sensitive` variable can never be read: an approved switch stored as sensitive, or an unreadable one, is reported as **unverifiable = fail**, never as a pass. A test pins that canary secrets never reach the output.

## Running it

```bash
# Offline, no secrets (what PR CI runs through the unit tests): evaluate an exported metadata snapshot
node web/scripts/release-parity.mjs --snapshot env-metadata.json

# Live, trusted release gate only (GitHub environment `release-parity`; never on pull requests)
node web/scripts/release-parity.mjs --live --deployment dpl_xxx --expect-sha <release sha>

# Functional probe of a deployment: nine class pages, icons in the HTML, CSP img-src, no unsafe-inline, no raw template tokens
node web/scripts/release-parity.mjs --probe https://<staged-deployment>.vercel.app --bypass-env VERCEL_AUTOMATION_BYPASS_SECRET
# ... or with a temporary, deployment-scoped Vercel shareable link (exchanged once for a session cookie; *.vercel.app hosts only)
node web/scripts/release-parity.mjs --probe https://<staged-deployment>.vercel.app --share-env STAGED_SHARE_SECRET
```

Exit 0 = pass, 1 = a check failed, 2 = unusable input (**NO-GO**, never a pass).

### Trust model

`release-parity.yml` has **no** `pull_request`/`pull_request_target` trigger: a pull request, including from a fork, can change the code
that would run next to the Vercel token. It runs on `workflow_dispatch`, on a push to `release`, and weekly, inside the
`release-parity` GitHub **environment** (restrict it to the `release` branch; keep `VERCEL_TOKEN` (read-only: project env + deployments),
`VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` there, not in repository secrets). Everything is a `GET`; nothing is deployed or changed.
A test asserts these properties of the workflow.

## Release runbook (owner / trusted operator)

The Vercel connector used by the automation can read neither environment variables nor create production ones (HTTP 403), so steps 1,
3 and 6 need a credentialed operator. **Auto-assign Custom Production Domains stays disabled throughout.**

1. Vercel project `prj_2NOZDdocNiHfZqhnYzxTRTHwxpOQ` -> Settings -> Environment Variables -> **Production only** (do not touch Preview or
   unrelated secrets), as plain (not sensitive) variables so they can be verified:
   `AZERDEX_TALENT_ICONS=cdn`, `AZERDEX_TALENT_TEXT=1` (plain or encrypted; **not** sensitive, which cannot be verified). Confirm `AZERDEX_ZONE_MAPS=1`, `AZERDEX_ZONE_HERO_SOURCE=cdn` and
   `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev` are present.
2. `node web/scripts/verify-talent-icons-cdn.mjs --dataset web/src/data/talents/forever/1.60.1.70634 --base https://azerdex-assets.pages.dev` (358/358, 404 control).
3. Create a **new** production deployment from the final `release` commit (a push to `release`, or "Redeploy" in the dashboard, which rebuilds with the variables as they are now). Never promote the previously promoted build: it was built without them.
4. Run the gate against it: `--live --deployment <dpl> --expect-sha <sha>` (Actions -> "Release parity gate (trusted)").
5. Verify the **staged** deployment (protection-bypass secret in an env var, never on the command line): `--probe`; then the browser acceptance below.
6. Promote exactly that deployment to `azerdex.com` and `www.azerdex.com`; keep the previous production deployment for rollback.

### Staged acceptance access

The staged deployment is behind Vercel Deployment Protection, which stays on for the whole project. Use a **temporary, deployment-scoped shareable link** (Vercel API `PATCH /aliases/{deploymentId}/protection-bypass` with a short `ttl`, e.g. 3600 s), keep the secret out of logs, reports and the repository, and **revoke it** (`revoke: {secret, regenerate: false}`) as soon as acceptance is done. Prove the revoke by checking that the old secret redirects to Vercel SSO again.

On a `*.vercel.app` deployment URL, Vercel itself adds `X-Robots-Tag: noindex` (the application sets none for a production designation, and when it blocks it sends `noindex, nofollow`), and a slightly different `Strict-Transport-Security`. These are host artifacts: judge the app by `<meta name="robots">`, the apex canonical, `X-ForeverDB-Deployment: production`, robots.txt and the sitemap, and **re-check the headers on the apex immediately after promotion**.

### Acceptance (all mandatory; any failure or "cannot verify" = NO-GO)

All nine class pages and 27 trees render with icons (`naturalWidth > 0`); tooltip and detail panel show the current and next rank
description; locked / available / selected / maxed states and the mobile and desktop calculator are intact; the `?` markers for the
103 nodes / 261 ranks with unresolved numbers are preserved (nothing invented); no raw `$s1`-style token; one dataset build
everywhere; CSP allows the asset host in `img-src` only, without `unsafe-inline`; no relevant console or network errors; Account and
Guildbook behaviour unchanged; GDPR consent and analytics gating unchanged; production canonical, robots and sitemap unchanged;
the beta unchanged.

### Rollback

Promote the previous production deployment (Vercel "Instant Rollback"). To withdraw the Blizzard content only: set
`AZERDEX_TALENT_ICONS` to anything but `cdn` and/or remove `AZERDEX_TALENT_TEXT`, then redeploy (the calculator falls back to name
plates and to the no-description state by itself). Note that the parity gate will then (correctly) fail until the policy is changed
by a reviewed commit.
