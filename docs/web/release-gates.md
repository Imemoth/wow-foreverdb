# ForeverDB Web — CI structure and release gates

**Enforcement status: PENDING.** The workflows below run and report, but *a successful workflow does not prove that merging is blocked when it fails.* Required status checks are repository settings (a ruleset or branch protection), not workflow content. They could not be created or read with the tools available for this change (no ruleset or branch-protection API), so nothing here claims the checks are enforced. Apply `.github/rulesets/main-release-gates.json` (instructions below) and then tick the verification box.

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

## 2. Required settings (PENDING — owner action)

Import `.github/rulesets/main-release-gates.json` (GitHub → Settings → Rules → Rulesets → New ruleset → Import a ruleset), or set the same in classic branch protection for `main`:

- Restrict deletions; block force pushes.
- Require a pull request before merging; require conversation resolution; dismiss stale approvals on push. `required_approving_review_count` is `0` because a single-owner repository cannot approve its own PR; raise it when a second reviewer exists.
- Require status checks to pass, **branch up to date before merging**, with exactly: `Web release gate`, `Web code quality`, `Web E2E (Playwright)`, `publisher-and-pipeline`, `codeql`, `collector-smoke`.
- No bypass actors (or, at most, the owner with "for pull requests only").

Verification that enforcement is real (tick only with evidence): open a throwaway PR that deliberately fails a unit test; confirm the **Merge** button is disabled and the PR page lists the failing required check; close the PR.

- [ ] Ruleset imported and active
- [ ] Failing-check merge block demonstrated

## 3. Merge precondition for the hardening PR

New code refuses to serve a hosted deployment that has no explicit designation. **Before merging this PR, set `FOREVERDB_DEPLOYMENT=preview` and `FOREVERDB_DATA_SOURCE=fixture` on the Vercel Production and Preview environments** (`docs/web/vercel-environments.md` §3). If the PR is merged first, the production alias will deploy and answer HTTP 500 until the variables are added and the project is redeployed (the previous deployment can be restored with Vercel Instant Rollback).

## 4. Operational verification (outside CI)

`web/scripts/verify-deployment.mjs` checks a *running* deployment (protected, preview, or future production). CI proves the code; this proves the deployment. Usage and the PENDING unauthenticated-access test are in `docs/web/vercel-environments.md` §5.
