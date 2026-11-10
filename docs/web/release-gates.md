# ForeverDB Web — CI structure and release gates

**Enforcement status (2026-11-03): `main` and `release` ACTIVE.** The live GitHub ruleset [#24853899](https://github.com/Imemoth/wow-foreverdb/rules/24853899) explicitly targets `~DEFAULT_BRANCH` (`main`) and `refs/heads/release`, with **ten required GitHub Actions checks** pinned to integration ID `15368`, no bypass actors, required PR, review thread resolution, deletion and force-push restrictions. The versioned `.github/rulesets/main-release-gates.json` is a documented **snapshot/template**, not an applied configuration: this PR brings it in line with the live ruleset. The classic branch protection API was inaccessible through the integration (403), and deliberate failing-check merge denial has not been tested. Recent Vercel production deployment records come from `release`, but the authoritative Vercel Branch Tracking and GitHub environment branch restrictions still need owner-level inspection before changing the production release process.

## 1. Jobs in `.github/workflows/web-ci.yml`

| Check name (exact) | Purpose | Steps (each is a separately named step) |
| --- | --- | --- |
| `Web code quality` | static and unit gates | Node major = `.node-version` = `engines` · `npm ci` · production dependency audit (high/critical fail) · ESLint · TypeScript · unit tests · **environment-boundary matrix** (local / preview / production, negative configurations) · production build with canary secrets · bundle-secret scan |
| `Web E2E (Playwright)` | browser and HTTP behaviour | build · search and navigation journeys · security headers, CSP, API validation and rate limiting · **preview safety** (synthetic banner, noindex header/meta, `robots.txt`, sitemap, headers, cookie flags, generic errors, no secrets, fail-closed misconfigurations) · accessibility regression (axe WCAG 2.2 AA) and SEO · responsive layout (desktop + mobile) |
| `publisher-and-pipeline` | unchanged | publisher tests · Supabase Edge Function lockfile frozen check and type-check · end-to-end publication pipeline on ephemeral PostgreSQL · website against the published read model (Postgres adapter) · fixture ↔ PostgreSQL parity |
| `codeql` | unchanged | CodeQL `security-extended` |
| `Dependency audit (web)` · `Dependency audit (publisher)` | npm advisories in both package roots | `npm ci --ignore-scripts` · production audit (**high/critical fail**) · full audit incl. devDependencies (**moderate and above fail**, judged by `web/scripts/audit-gate.mjs` on the structured JSON; the only exception is the owner-approved, time-limited one in [`dependency-audit-exceptions.md`](dependency-audit-exceptions.md)); on failure the findings go to the job summary and a 14-day `npm-audit-<root>` artifact. See §5 |
| `Web release gate` | aggregate | fails unless every one of the five jobs above (the two audits count as one job) is `success` (failed, cancelled and **skipped** all fail it) |

Design points:

- **No `paths:` filter.** A path-filtered workflow does not report on unrelated PRs, and a required check that never reports blocks the PR forever (or is silently waived). Every PR now reports every check. With the branch governance PR it also runs on pushes to both `main` and `release` so the merged result is tested on both protected branches.
- **Check names are a contract.** Renaming a job silently orphans the ruleset entry. Previously the single job was called `web`; if a ruleset still lists `web`, replace it with the names above.
- `concurrency` cancels superseded runs of the same ref; the gate treats a cancelled upstream job as a failure.
- Other workflows are intentionally **not** required: `Companion health checks` (Windows, path-filtered to Companion files) and `ForeverDB API security regressions` (`pg-roles-quotas`, path-filtered to `database/**`) only run when relevant, so requiring them would block unrelated PRs. `collector-smoke` runs on every PR and is required.
- No auto-merge is configured anywhere.

## 2. Required settings and verification

- [x] **`main` protected:** live ruleset #24853899 active and includes `~DEFAULT_BRANCH` (currently `main`).
- [x] **`release` protected:** live ruleset explicitly includes `refs/heads/release`; the branch reports `protected: true`.
- [x] **Ten required check contexts** under integration ID `15368`: `Web release gate`, `Web code quality`, `Web E2E (Playwright)`, `publisher-and-pipeline`, `codeql`, `collector-smoke`, `Account web auth (real GoTrue)`, `Account ownership SQL + real GoTrue`, `Companion account auth (Windows)`, `Account end-to-end (GoTrue + PostgREST)`. GitHub Actions runs for every PR without required-workflow path filters.
- [x] **PR and history protection:** no bypass actors; pull request required; review threads resolved; strict up-to-date checks; no deletion or non-fast-forward push. Current `required_approving_review_count=0` (single-owner repository).
- [ ] **Classic branch protection verified independently:** the GitHub integration returned 403; an administrator should confirm any additional overlapping classic rules.
- [ ] **Failing-check merge denial verified:** test with a safe throwaway PR containing an intentionally failing required check, then close it; do not weaken rules to test.
- [ ] **Vercel Production Branch Tracking UI confirmed:** recent production deployment records have `githubCommitRef=release`, but the authoritative branch-tracking setting still requires an owner screenshot/inspection.
- [ ] **`release-parity` / `publication` environment branch restrictions verified:** both should allow `release` only; `publication` should retain an owner approval gate.

**Do not recreate or overwrite ruleset #24853899** from an obsolete six-check example. If any change is approved, update that existing ruleset in GitHub Settings and keep the ten exact context names/source integration stable. The versioned JSON records the observed state; GitHub never applies it automatically.

No automatic main-to-release promotion is configured. Release promotion requires a separate, reviewed PR to the protected branch.

## 3. Completed hardening merge

PR [#45](https://github.com/Imemoth/wow-foreverdb/pull/45) was squash-merged as `6b49a3f` on 2026-10-11. Vercel Production and Preview targets already declare the required environment variables; effective Preview/fixture behaviour was verified before merge. The post-merge production-target deployment is READY, under Vercel Authentication **All Deployments**. This does **not** authorize `FOREVERDB_DEPLOYMENT=production` or public publication.

## 4. Operational verification (outside CI)

`web/scripts/verify-deployment.mjs` checks a *running* deployment (protected, preview, or future production). CI proves the code; this proves the deployment. Usage and the PENDING unauthenticated-access test are in `docs/web/vercel-environments.md` §5.

## 5. Dependency audit gate: investigating a finding

`Dependency audit (web)` and `Dependency audit (publisher)` fail on any production advisory of severity high or above, or any advisory of severity moderate or above anywhere in the tree (devDependencies included), **except** an advisory covered by an exact, in-force, owner-approved exception in `.github/audit-exceptions.json` (currently one: GHSA-g3hv-75wg-m249, expiring 2026-12-15; see [`dependency-audit-exceptions.md`](dependency-audit-exceptions.md)). The production audit has no exception mechanism. The failing job's summary lists the advisories and `npm-audit-<root>` holds the JSON. Locally:

```bash
cd publisher            # or web
npm ci && npm audit      # advisory, severity, vulnerable range, fix availability
npm explain <package>    # which dependency path pulls it in (direct, or transitive via what)
npm audit --omit=dev     # is it in the production tree, or dev-only?
```

- Fix with the **smallest** version that clears the advisory range, as an exact pin like the rest of the manifest (`npm install <pkg>@<exact> --save-exact`). If the advisory has no patched release in the current major, a major bump is unavoidable: say so in the PR and run the full test matrix. Do **not** use `npm audit fix --force`, `overrides` or an ignore list to get a green check; an exception needs the owner's decision recorded in the PR. (The one owner-decided exception to this rule is the scoped `@typescript-eslint/typescript-estree` > `minimatch` override documented in `docs/web/dependency-audit-exceptions.md`.)
- A fix is not the same as exposure. Check what the advisory really covers before claiming protection (for example the zod fix in 4.6.6 only makes arrays with `.max()`/`.length()` reject oversized input early; arrays with no maximum still accumulate one issue per failing element). Note the reachable inputs: the publisher parses the private export and the repo-owned config, never request bodies.
- `publisher/`'s zod is also pinned in `supabase/functions/publish-observations/deno.json`. Bump both, run `node scripts/sync-edge-core.mjs`, and treat the Edge Function as **not updated in production until the owner deploys it**.
- A brand-new advisory can turn an unrelated PR red. That is the gate doing its job: fix or consciously decide, do not re-run until it passes.

## 6. Supabase Edge Function lockfile (`publish-observations/deno.lock`)

CI pins Deno **2.1.4** (the Supabase Edge runtime's compatible version). The lock is checked with `deno cache --frozen index.ts`, which fails if `deno.json` and the lock disagree or an integrity hash does not match, and is run **before** `deno check` (a non-frozen check rewrites an out-of-date lock inside the runner and would hide drift).

Why not `deno check --frozen`: type-checking injects an implicit `@types/node` whose version belongs to the Deno release (2.1.x: 22.5.4 · 2.2-2.3: 22.12.0 · 2.5: 24.2.0). Deno before 2.6 never writes that entry to the lock, so `deno check --frozen` fails on the pinned Deno no matter what lock is committed (even one freshly generated by that same Deno). The lock committed before this gate existed passes `check --frozen` only on Deno 2.6.8 of the versions tried, i.e. it was most likely written by a 2.6-line Deno, which CI does not use. `deno cache --frozen` resolves the same module graph without the injection and passes on Deno 2.1 through 2.6.

Changing a dependency in `deno.json`:

1. Edit `deno.json` (and keep `publisher/package.json` in step if it is zod).
2. From `supabase/functions/publish-observations`, with **Deno 2.1.4**: `deno cache index.ts`. If a package that is also an optional peer of a transitive dependency changed (zod <-> `openai`), the old resolution can linger in the lock: delete `deno.lock` and run `deno cache index.ts` again, which re-resolves everything. Expect the implicit `@types/node`/`undici-types` entries to change (type-only, owned by Deno), and note that `jsr:@supabase/functions-js` in `index.ts` is unversioned, so a from-scratch resolution picks its newest release.
3. Review the diff of `deno.lock`: only the intended packages (plus the type-only entries above) should move. Then `deno cache --frozen index.ts && deno check index.ts`.

## Account System V1 additions (planned)

PR B adds a CI job that runs the Supabase local stack (GoTrue, PostgREST, Postgres, Mailpit) inside GitHub Actions for account acceptance; it joins the aggregate `Web release gate` once it is stable (a new required context needs the ruleset edited by the owner, with the same GitHub Actions app pin). PR D adds a Windows `dotnet test` job. Until then PR A only extends `Web code quality` (account unit and static boundary tests run inside `npm test`).
