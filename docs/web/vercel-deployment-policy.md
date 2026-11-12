# Vercel deployment policy — AzerDex

Status: proposed, implementation review required. Production branch: `release`; `main` is not the production branch.

## Principle

Only deploy the Next.js website when its build inputs or website behavior can change. Never disable GitHub CI, Supabase migrations, review gates, or owner approval on the grounds that Vercel skipped a deployment.

The repository is a monorepo; Vercel Root Directory must remain `web` for `web/vercel.json` to apply. Verify the live project setting during review. The Ignored Build Step uses `VERCEL_GIT_PREVIOUS_SHA` and compares the last successful deployment to HEAD, **not** just HEAD^; the first deployment, missing Git history, invalid SHA, or diff failure always builds. Vercel exit code 0 skips; exit code 1 builds.

## Classification (conservative)

- Skip: `docs/**`, `database/**`, `addon/**`, `addons/**`, `companion/**`, `Companion/**`, `desktop/**`, `.github/**`, `.mcp.json`, root-level README/CONTRIBUTING/LICENSE/CHANGELOG, `web/tests/**`, `web/docs/**`, `web/README.md`.
- Build: every other `web/**` change, including `web/content/**`, `web/public/**`, source, package lock, `next.config.ts`, build scripts and this policy's runtime code; unknown or shared root paths build by default.
- Multi-file changes: **any build-relevant path** triggers a build, even if most changes are docs/backend.
- If a path is later consumed by Next.js compilation, move it to the build-relevant set in the same reviewed PR. Do not silently broaden the skip allowlist.

Important: a backend SQL migration can be operationally required independently of web deployment. Skipping Vercel does not apply migrations or imply backend rollout readiness.

## Acceptance before merge

1. Unit tests for documentation-only, SQL-only, Companion-only, web-test-only, mixed code + docs, web content, public images, config, empty/malformed diff and unknown paths.
2. Verify representative historical commit diffs and multiple-commit pushes; confirm Git metadata is actually available on Vercel and first deployment fails open.
3. Verify Vercel Root Directory and configuration precedence; do not create a duplicate conflicting Dashboard Ignored Build Step.
4. CI and Vercel preview test on the exact Draft PR HEAD. Explicitly verify expected `SKIP` and `BUILD` outcomes from Vercel logs.
5. Production builds remain staged, smoke-tested and owner-promoted, never automatically promoted by this policy. Do not merge or change live Vercel configuration without owner review.

## Deployment-retention and cleanup

Suggested *future* retention, subject to plan support: canceled 1 day, errored 7 days, preview 7 days, production 30 days. Active aliased, approved staged, rollback and PR-acceptance deployments are protected independently of age.

Perform a fresh read-only inventory immediately before any cleanup, enumerating **every deployment** and cross-checking each with live custom domains, aliases, rollback candidates, staged promotion state, open GitHub PRs and their acceptance links. Export an immutable CSV/JSON manifest containing project, deployment ID, SHA, branch, status, creation date, alias, PR status, changed files, classification, reasons and protection state. Delete only explicitly approved IDs; never use broad regex/age-only deletion. Confirm storage savings from Vercel Usage, accounting for shared assets and deduplication.

Previously identified protection candidates (reverify, do not assume still current):
- Live azerdex.com: `dpl_GP8WX69SWkEQ2NVcatyhe4vkxBnL`
- Beta alias: `dpl_2i7ZAv2VMdpBFoVAxWsmuLhi6Gw4`
- Latest staged production at audit: `dpl_BptRn2vLa2RV7W8rFTM56ESbvuCR`

Source of truth for new development: this versioned policy in the `release` line; reconcile into `main` through a reviewed sync, and branch new work from the correct, updated base.
