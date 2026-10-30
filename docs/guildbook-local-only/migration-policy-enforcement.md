# Guildbook migration policy: what the guard enforces, how it could be bypassed, and what needs GitHub settings

**Nothing in this document changes any repository setting, and no repository-wide enforcement is claimed.** Facts about GitHub settings below were read through the read-only API on 2026-10-30 and can change at any time; verify them again before relying on them.

## 1. Policy
Owner policy (final): Guildbook data never lives in, flows through or is served by the cloud. Migration 0018 is the server-side kill switch. **Migration 0016 (account-scoped cloud Guildbook storage, sibling branch) is permanently retired**: its purpose contradicts the policy and it must not be merged in any form. **Migration 0017 (independent collectors) is a different subject** and is judged only by what it does; it is not prohibited by its number.

## 2. What the repository guard does (and does not)
`web/tests/unit/guildbook-migration-guard.test.ts` with `web/tests/unit/support/guildbook-policy.ts`, run by the **Web code quality** job (vitest):

| Check | Effect |
| --- | --- |
| Content rules over every migration that is not a reviewed file | A migration is flagged when its SQL (comments excluded) mentions `guil…` (guild, guilds, guildbook, `installation_guild*`, `account_guildbook_*`), the private ingest implementation (`foreverdb_ingest_snapshot_impl*`), the 0018 projection (`fdb_public_snapshot`) or the kill-switch marker (`cloud_sync_guard`); builds GRANTs dynamically with `format()`; or assembles identifiers from fragments / base64 / chr(). **The rules take SQL text only: there is no file-name parameter**, so renaming 0016 changes nothing, and a 0017 that has nothing to do with Guildbook passes. Unit tests prove both (renamed 0016-like content under any name is flagged; a collector-style migration is not). |
| Content hash pin of every existing reviewed migration (0001-0015) | Editing an already-applied/allowlisted migration (for example to re-grant a Guildbook function) fails until `REVIEWED_MIGRATIONS` is changed in the same, visible diff. Line endings are normalised, so Windows and Linux agree. |
| 0018 properties | strip-before-persist, catalog revoke sweep from all four API roles, no delete/truncate, refusal of unexpected states, durable private marker. |
| `guildbook-approval-pins.test.ts` | SHA-256 of 0018 and of the four operator scripts equals the table in `0018-approval-checklist.md`: editing any of them restarts the review. |
| SQL suites in CI (real PostgreSQL + GoTrue) | behaviour: legacy ingest stores no guild row, retired RPCs are denied, three migration orders, restore/reassert/cleanup. |

Verified by mutation on this branch (each made the guard fail, then was reverted): a renamed 0016-like table under `0042_widget_tuning.sql`; appending a Guildbook GRANT to the allowlisted `0015`; and, in the other direction, a benign `0017_independent_collectors.sql` did **not** fail it.

## 3. How the guard itself could be bypassed (honest review)
| Attack / mistake | Caught by the repository guard? | What closes it |
| --- | --- | --- |
| New migration under any name that touches Guildbook structures | **Yes** (content rules) | - |
| Edit an allowlisted migration (0001-0015) | **Yes** (hash pin) | - |
| Edit 0018 or an operator script | **Yes** (approval pins) | - |
| **Edit or delete the guard test, the policy module, the pins test or the checklist in the same PR** | **No** for the vitest guard (ordinary files; deleting a test file makes the job pass with fewer tests). **Yes, once section 6 is in place**: the owner's `guildbook-local-only-policy` workflow runs the scanner from the *trusted base branch*, so a PR cannot weaken the check that judges it | land the workflow on every target branch and make `guildbook-local-only-policy` a required check (section 6); plus review of the policy paths (CODEOWNERS, section 4) |
| Obfuscation not covered by the rules (a clever dynamic-SQL assembly) | partly: fragments, base64/chr and dynamic grants are flagged; the rules are heuristics | human review of any migration that uses dynamic SQL; the SQL **behaviour** suites are the real net |
| A migration applied by hand to a database, or `rollback/0012_kill_switch_restore.sql` run without the reassert | **No** (outside git) | operational: post-apply inventory check and `guildbook_local_only_reassert.sql` (checklist, sections E and F) |
| A migration landing in a branch that is **not** gated by required checks (see section 4) | the check runs and is visible, but is not mandatory there | ruleset coverage |
| A path-filtered workflow used as the only gate | **No** (skipped workflows report nothing) | only required checks that always report |

## 4. What is true on GitHub today (read-only, 2026-10-30) and what would be needed

Verified:
- One **active** ruleset, "main release gates", targets **`~DEFAULT_BRANCH` (main) and `refs/heads/release` only**; no bypass actors; blocks deletion and non-fast-forward; requires a pull request with **0** approving reviews, stale-review dismissal on push and thread resolution; **`require_code_owner_review: false`**.
- Its required status checks (strict: branches must be up to date): `Web release gate`, `Web code quality`, `Web E2E (Playwright)`, `publisher-and-pipeline`, `codeql`, `collector-smoke`, `Account web auth (real GoTrue)`, `Account ownership SQL + real GoTrue`, `Companion account auth (Windows)`, `Account end-to-end (GoTrue + PostgREST)`.
- `release-rc/azerdex-beta-20261030`, `feat/azerdex-gdpr-consent` and `fix/guildbook-local-only-rc` have **no ruleset and no classic branch protection**. So the stack (#143 → #142 → #141) is not mechanically gated until a change reaches `release`; the guard's result is visible on each PR but not mandatory there.
- The guard runs inside `Web code quality` and the new SQL tests inside `Account ownership SQL + real GoTrue`: **both are already required for `release`/main.**

Not required today, and worth considering (each is an owner decision on repository settings; none was changed):
1. **Add `AzerDex welcome outbox SQL + real GoTrue + worker`** to the required checks: it runs the same database suite on a second layout (different migration set), which already exposed a layout-dependent failure once.
2. **Extend the ruleset's branch patterns** to `release-rc/**` (and, if wanted, the feature/fix branches that stack onto it) so the stack is gated before the last hop.
3. **Require code-owner review for the policy files.** Proposed `.github/CODEOWNERS` (not added by this PR, because it changes review routing):
   ```
   /database/migrations/                       @Imemoth
   /database/ops/guildbook_*                   @Imemoth
   /database/rollback/                         @Imemoth
   /web/tests/unit/guildbook-*.test.ts         @Imemoth
   /web/tests/unit/support/guildbook-policy.ts @Imemoth
   /docs/guildbook-local-only/                 @Imemoth
   ```
   together with `require_code_owner_review: true` and at least 1 approving review. **Constraint:** this repository currently has a single administrator who is also the author of every PR, and GitHub does not let an author approve their own PR. Either a second reviewer account is needed, or the owner accepts that policy-file edits are protected only by their own attention. This needs a decision, not a code change.
4. **Do not make `Guildbook Windows acceptance harness synthetic` a required check as it is**: that workflow has a `paths:` filter, so on PRs that do not touch those paths it reports nothing and a required check would block them indefinitely. Make it path-independent first (as the other required workflows are) if it should be mandatory.
5. Keep **"Do not allow bypassing the above settings"** (no bypass actors, as today) and keep deletion and force-push blocked.

Until the owner has applied and re-verified these settings, describe the protection as: *a review-time guard that runs in two already-required checks for `release` and main, and is not itself protected against being edited by the author of a PR*.

## 6. The owner's trusted-base workflow (commit 1385e60) and how it relates to the vitest guard
`.github/workflows/guildbook-local-only-policy.yml` + `scripts/check-guildbook-local-only-policy.mjs` (+ its node tests, `branch-protection.md`, `branch-ruleset.json`, `0016-branch-audit.md`) add a second, independent layer:
- **Trust model (stronger than the vitest guard):** it uses `pull_request_target`, loads the workflow and scanner from the PR's **base** commit, and checks the proposed tree out only as inert SQL. A PR that edits the scanner, its tests or this guard cannot change the verdict on itself. This is the only layer in the repository that can close the "edit the guard in the same PR" gap, and only on branches whose history already contains the workflow.
- **Rules:** reserves the filename prefix `0016` permanently (a name rule, deliberate: 0016 is retired), pins the approved 0018 by hash and four historical files (0005, 0009, 0012, 0014) by hash, and scans everything else after stripping comments for Guildbook storage, RPCs, grants, copies, writes and the ingest wrapper. It is content-based beyond the reserved 0016 prefix: an unrelated 0017 passes (its tests prove this).
- **Overlap with the vitest guard (defence in depth, not duplication of trust):** the vitest guard additionally hash-pins *all* reviewed migrations (0001-0015) and checks dynamic-grant/assembled-identifier tricks; the workflow runs from trusted code. They agree on the current tree (both pass) and neither blocks a Guildbook-free 0017.
- **Not yet effective:** a `pull_request_target` workflow takes effect only from a branch that already contains it, and a status check blocks merging only if it is **required**. Today (read-only API, 2026-10-30) the context `guildbook-local-only-policy` is **not** in any ruleset, and it does not exist on `release`, `release-rc/azerdex-beta-20261030` or `feat/azerdex-gdpr-consent` yet, so it does not run on #143, #142 or #141. Rollout order, with ordinary commits and no force-push, is in `branch-protection.md`.
- **Correction to `branch-protection.md`:** it says no ruleset could be read because the credential was invalid. With a valid credential the existing ruleset *can* be read (section 4 lists it); the conclusion there ("no branch is yet confirmed protected by this check") remains correct.

## 5. If 0016 or 0017 are ever proposed
- **0016 (account-scoped cloud Guildbook): do not merge, in any form or under any name.** If an owner decision ever reverses the policy, that is a new decision with its own review; the guard, 0018 and the privacy notice would all have to change together.
- **0017 (independent collectors):** rebase it onto the release line and let the guard judge it by content. It must not touch Guildbook structures or the ingest implementation (if it must, the change needs the reviewed edit described in `db-changes.md` section 4). Re-run the SQL suites, including the migration-order tests, with 0017 present.
