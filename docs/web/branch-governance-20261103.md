# AzerDex / ForeverDB branch governance (DRAFT, 2026-11-03)

> **Proposal only.** This is CI/configuration staging on a feature branch. No
> default-branch, ruleset, Vercel/Supabase, production, or deployment change
> is authorized by this PR. Owner approval is required before merging.

## Decision proposed

- `main`: **GitHub default**, stable integration target of feature, addon,
  Windows Companion, and Dependabot version/security PRs. Passing CI does not
  authorize deployment.
- `web/azerdex-beta`: public beta/staging, synchronized from reviewed
  subsets of `main` by PR, validated on beta, not a general feature sink.
- `release`: protected production source. Changes enter by curated,
  owner-approved PR/RC/hotfix from the verified release baseline. Never
  automatically merge all of `main` to `release` once it has unfinished work.

## Verified GitHub snapshot

- Default: `main`, current post-sync SHA `9fafbee80745312052319e5c8408dba00f347383`.
- Production source: `release`, SHA `198004266b98aa40a515a1c12e88a5209bd3de73`.
- `main` is 1 merge commit ahead; the two branch trees have **no file diff**.
- `web/azerdex-beta` is 81 commits behind and 1 commit ahead of `main`.
  Its unique commit is a historical release parity implementation; the
  current `main` contains revised later versions of several of its files.
  **Do not reset or force-push beta**. Resolve beta's divergence in a separate
  reviewed merge/rebase plan and test preview behaviour before promotion.
- Live active GitHub ruleset #24853899 applies to `~DEFAULT_BRANCH` and
  `refs/heads/release`: required PR, review thread resolution, force-push
  and deletion prevention, strict required checks, no bypass actors. Ten
  GitHub Actions check names are currently required. Classical branch
  protection details could not be independently read (403 via integration).

## Change set in this proposal

1. Keep `.github/dependabot.yml` targeting the repository default by
   **omitting** `target-branch` for `web`, `publisher`, and
   `github-actions`. Only clarify the policy in comments.
2. Run the existing universal CI workflows on pushes to both `main` and
   `release`. They already run on PRs without branch filters. Do not rename
   required status checks or apply paths filters to required workflows.
3. Fix the weekly release parity trust boundary: GitHub `schedule` always
   runs on the default branch. A new default-branch schedule dispatcher with
   `actions: write` and **no Vercel secrets** triggers
   `release-parity.yml` on ref `release` via `workflow_dispatch`.
   The release parity worker refuses all other refs and uses the protected
   `release-parity` environment. Keep that environment **release-only**.
4. Restrict the manual publisher to runs on `release` with a fail-closed
   preflight BEFORE its secret-bearing `publication` environment. Keep
   `dry_run: true` by default and independently restrict the environment
   to `release` with required owner approval before any real publishing.
5. These changes are not deployments; web and database runtime logic are
   untouched.

## Owner decision and execution gates

1. Approve or reject this branch strategy; inspect Vercel's actual Production
   Branch Tracking (expected `release`) and beta branch mapping, and confirm
   real release promotion is still manually authorized and rollback tested.
2. Confirm the `release-parity` and `publication` environment branch
   restrictions AND reviewer/secrets policy via GitHub Settings. The
   environment and Classic branch-protection APIs were not verifiable through
   the GitHub integration; do not infer protection from repository files.
3. Review this Draft PR and run full exact-head CI, GitHub ruleset + branch
   protections, YAML syntax/actionlint and the new fail-closed guard checks.
   Ensure the scheduler's GITHUB_TOKEN can dispatch via actions:write.
4. After owner GO, merge the CI-only changes to `main`; deploy neither app
   nor SQL. Propagate release-only safety workflow changes to `release`
   through an independently approved, reviewed release PR, aware that Vercel
   might rebuild the same web tree on a release push.
5. Stage a dedicated `main -> web/azerdex-beta` synchronization PR. Preserve
   beta's distinct commit, resolve conflicts, verify SSR/SEO/CSP/consent/
   Guildbook, and confirm beta branch tracking. No force push.
6. Once beta is aligned, stage curated release candidate PRs. Never merge a
   broad `main` history into `release` after unrelated work accumulates.

## Dependabot and security-specific policy

- `target-branch` omitted means both regular version PRs and *security*
  update PRs target default `main`.
- Security updates are advisory-triggered independently of the monthly
  version-update schedule; semver allowlists and PR limits here do not
  silently disable security fixes.
- Vulnerability/CodeQL triage on `main` immediately; run all GitHub CI
  and supply-chain/lockfile audits. For a fix needed in production, create a
  minimal hotfix branch off current `release`, apply only the vetted security
  fix, run production-compatibility + CI, then approve a release PR. Ensure
  `main` retains the fix. Never automate production promotion.
- Open draft dependency PRs #150 (publisher) and #151 (web) currently target
  `release`. After this strategy is **approved**, retarget to `main`,
  verify GitHub's diff is unchanged and rerun exact-HEAD checks; do not
  merge the draft PRs automatically.
- PR #124 (Nozdormu adapter PoC) also targets `release` and should be
  evaluated for retargeting to `main`. PR #127 targets the diverged beta
  branch and should wait for beta reconciliation. Companion #81/#82/#83
  and Atlas #74/#75 form stacked chains: preserve their bases and review
  integration dependencies before retargeting.

## Post-change acceptance

- `main` push and `release` push each start universal required workflows.
- `release-parity-schedule.yml` performs only a release-ref dispatch; no
  secret is available to the scheduled job on `main`.
- Manual `release-parity.yml` and `publish-public-db.yml` from `main`
  must fail the ref check without contacting Vercel/databases.
- Equivalent invocations on `release` must respect both protected
  environments, run only with owner approval if configured, and must not
  promote/deploy as a side effect of this change.
- Security PRs, routine Dependabot PRs and Companion feature PRs target
  `main`, and required status checks remain unchanged.
- No changes to Vercel alias/environment/production branch tracking,
  Supabase, or production application code are included.
