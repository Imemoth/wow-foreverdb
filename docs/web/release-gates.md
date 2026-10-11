# ForeverDB Web — CI structure and release gates

**Enforcement status (2026-10-11): `main` ACTIVE / `release` PENDING.** GitHub API confirmed repository ruleset [#24853899](https://github.com/Imemoth/wow-foreverdb/rules/24853899) applies to the default branch, with all six status checks pinned to GitHub Actions integration ID `15368`, no bypass actors, required PR, deletion and force-push restrictions. A deliberately failing PR has **not** been used to prove merge denial. The new `release` branch exists but its protection and Vercel branch tracking still require owner setup. A repository JSON file cannot change live repository settings by itself.

## 1. Jobs in `.github/workflows/web-ci.yml`

| Check name (exact) | Purpose | Steps (each is a separately named step) |
| --- | --- | --- |
| `Web code quality` | static and unit gates | Node major = `.node-version` = `engines` · `npm ci` · production dependency audit (high/critical fail) · ESLint · TypeScript · unit tests · **environment-boundary matrix** (local / preview / production, negative configurations) · production build with canary secrets · bundle-secret scan |
| `Web E2E (Playwright)` | browser and HTTP behaviour | build · search and navigation journeys · security headers, CSP, API validation and rate limiting · **preview safety** (synthetic banner, noindex header/meta, `robots.txt`, sitemap, headers, cookie flags, generic errors, no secrets, fail-closed misconfigurations) · accessibility regression (axe WCAG 2.2 AA) and SEO · responsive layout (desktop + mobile) |
| `publisher-and-pipeline` | unchanged | publisher tests · end-to-end publication pipeline on ephemeral PostgreSQL · website against the published read model (Postgres adapter) · fixture ↔ PostgreSQL parity |
| `codeql` | unchanged | CodeQL `security-extended` |
| `Web release gate` | aggregate | fails unless every one of the four jobs above is `success` (failed, cancelled and **skipped** all fail it) |

Design points:

- **No `paths:` filter.** A path-filtered workflow does not report on unrelated PRs, and a required check that never reports blocks the PR forever (or is silently waived). Every PR now reports every check. The workflow also runs on pushes to `main` so the merged result is tested.
- **Check names are a contract.** Renaming a job silently orphans the ruleset entry. Previously the single job was called `web`; if a ruleset still lists `web`, replace it with the names above.
- `concurrency` cancels superseded runs of the same ref; the gate treats a cancelled upstream job as a failure.
- Other workflows are intentionally **not** required: `Companion health checks` (Windows, path-filtered to Companion files) and `ForeverDB API security regressions` (`pg-roles-quotas`, path-filtered to `database/**`) only run when relevant, so requiring them would block unrelated PRs. `collector-smoke` runs on every PR and is required.
- No auto-merge is configured anywhere.

## 2. Required settings and verification

- [x] **`main` protected:** ruleset `24853899` Active, targets default branch; six required GitHub Actions checks use `integration_id: 15368`; enforced PR, no force push, no deletion; empty bypass list (GitHub API, 2026-10-11).
- [ ] **`release` protected:** same active ruleset also targets exact branch `release` (`refs/heads/release`). Branch reports `protected: true`. The versioned `.github/rulesets/main-release-gates.json` now describes both branches, but is **not** automatically applied.
- [ ] **Failing-check merge denial verified:** use a safe throwaway PR that deliberately fails an existing required test, confirm the merge is blocked, then close it. Do not weaken rules to conduct the test.
- [ ] **Vercel Production Branch = `release` verified:** details in [vercel-environments §6](vercel-environments.md#6-production-promotion-control).

The owner should **edit the existing ruleset** rather than create a second overlapping ruleset. In Target branches, keep Default branch and add `release` using Include by pattern. Preserve:

- Pull request required; review threads resolved; dismiss stale reviews; `required_approving_review_count=0` while the repository has one owner.
- Deletion and force-push restrictions; no bypass actors.
- Required checks: `Web release gate`, `Web code quality`, `Web E2E (Playwright)`, `publisher-and-pipeline`, `codeql`, `collector-smoke`, each with expected source **GitHub Actions** (app ID `15368`).
- Require the branch to be up to date (`strict_required_status_checks_policy=true`). GitHub Actions workflows run for all PRs, including PRs to `release`.

No automatic main-to-release promotion is configured. Release promotion requires a separate, reviewed PR to the protected branch.

## 3. Completed hardening merge

PR [#45](https://github.com/Imemoth/wow-foreverdb/pull/45) was squash-merged as `6b49a3f` on 2026-10-11. Vercel Production and Preview targets already declare the required environment variables; effective Preview/fixture behaviour was verified before merge. The post-merge production-target deployment is READY, under Vercel Authentication **All Deployments**. This does **not** authorize `FOREVERDB_DEPLOYMENT=production` or public publication.

## 4. Operational verification (outside CI)

`web/scripts/verify-deployment.mjs` checks a *running* deployment (protected, preview, or future production). CI proves the code; this proves the deployment. Usage and the PENDING unauthenticated-access test are in `docs/web/vercel-environments.md` §5.
