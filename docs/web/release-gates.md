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

## Account System V1 additions (planned)

PR B adds a CI job that runs the Supabase local stack (GoTrue, PostgREST, Postgres, Mailpit) inside GitHub Actions for account acceptance; it joins the aggregate `Web release gate` once it is stable (a new required context needs the ruleset edited by the owner, with the same GitHub Actions app pin). PR D adds a Windows `dotnet test` job. Until then PR A only extends `Web code quality` (account unit and static boundary tests run inside `npm test`).

## Browser Pairing V1 release gate

Browser Pairing V1 may not be promoted merely because the existing aggregate web gate is green. Its Draft PR must also report, on the
same final commit, the disposable Account/PostgREST/PostgreSQL pairing suite, migration 0016 concurrency/rollback suite, Windows
Companion Account tests and WPF Release build, CodeQL, bundle-secret scan and the source/database feature-gate checks. A failed,
cancelled or skipped required pairing job is a failure.

Promotion additionally requires the owner evidence OA-1..OA-10 in
[the pairing acceptance plan](../account-v1/browser-pairing-test-and-acceptance.md), two independent final-diff reviews and a separate
production go/no-go. Applying migration 0016, enabling its private config row, changing either source approval flag, merging the Draft
PR and publishing the installer are distinct owner-controlled actions. None is implied by CI success.

Stage B adds two mandatory workflow steps without changing the live ruleset:

- `Account ownership SQL + real GoTrue` applies 0016 only after the 0012 and 0014 regression suites, then runs the step
  `Browser pairing SQL + real GoTrue`, the mandatory `Browser pairing mutation check`, and
  `scripts/check-pilot-flags.py --require-off` on every pull-request/push run.
- `Account end-to-end (GoTrue + PostgREST)` runs `10-browser-pairing-sessions.spec.ts` alone in the step
  `Browser pairing GoTrue session lifecycle`. A zero-test, skipped or failed result fails the step. The JSON report, GoTrue and
  PostgREST logs, and lock-wait evidence are uploaded even on failure. The other pairing browser tests run in the integrated acceptance
  step.

The E2E job builds its disposable pairing artifact with `web/tests/e2e-stack/build-pairing.sh`. That helper requires the reviewed
literal-false source gate, changes it only for the local `.next` build, restores the source on success or failure, and reruns the
repository OFF scanner. The checked-in gate therefore remains false while the browser tests can exercise the implemented routes.

Local evidence at code head `2537ec4` is green: Account 219/219, enrollment 99/99, pairing 146/146, mutation 16/16, web 474/474 and
real-stack browser acceptance 66/66, all with zero skips; both production builds and 48-file bundle scans pass. This is development
evidence only. The final documentation commit still needs the same required GitHub checks on one exact SHA before Stage B can exit.

One exact final Git commit must report success for Web code quality, Web E2E, Account ownership SQL + real GoTrue, Browser pairing
mutation coverage, Account end-to-end including the named lifecycle step, Companion account auth, CodeQL, bundle-secret scan, the full
OFF-gate scan and `git diff --check`. Failed, cancelled, missing or skipped required evidence is a Stage B failure. Component results
from different commits may guide development but cannot be combined into a release result.

The native endpoint ingress gate also remains open. A raw HTTP Preview check at `12447a5` observed Vercel reject all 9/9 tested
duplicate/case-variant `Authorization` requests with an edge HTTP 400, while single-header controls reached the application. Vercel's
official documentation does not guarantee that behavior before Functions/Routing Middleware. Browser Pairing must remain OFF until the
provider gives that guarantee or the owner approves another architecture.
