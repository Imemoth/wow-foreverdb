# Account V1 — integration chain, merge order and pilot-flag release gate

Facts read from GitHub on 2026-10-13 (all four PRs are **draft**, nothing is merged):

| PR | Branch → base | Content |
| --- | --- | --- |
| #53 | `account/v1-single-project-production-candidate` → `main` | web Account Auth boundary, single-project pilot, production Auth OFF by default |
| #54 | `companion/private-supabase-account-pilot` → #53 | Companion registered login pilot (isolated vault) |
| #55 | `companion/private-claim-single-install-pilot` → #54 | one-installation claim pilot, original identity protection |
| #56 | `account/v1-zero-touch-enrollment-registered-sync` → #55 | **this PR**: migration 0014, ADR-017, website ticket/device flow, Companion enrollment + device sync |

## Temporary pilot approvals in the chain

`python3 scripts/check-pilot-flags.py` reports them (exit 0) and `--require-off` fails while any is on:

| Flag | File | State on this branch | Introduced by |
| --- | --- | --- | --- |
| `SINGLE_PROJECT_PILOT_APPROVED` | `web/src/lib/account/config.ts` | **true** | #53 |
| `PrivateProjectPilotApproved` | `companion/.../AccountFeatureGate.cs` | **true** | #54 |
| `PrivateProjectClaimPilotApproved` | same | **true** | #55 |
| `ProductionAccountAuthApproved`, `PRODUCTION_ACCOUNT_AUTH_APPROVED` | companion / web | false | — |
| `ZeroTouchEnrollmentApproved`, `DeviceAutoSyncApproved` | companion | **false** (added by #56, no approval granted) | #56 |

#56 adds **no** new enabled approval and flips none of the existing ones (the owner's pilot still depends on them). Zero-touch enrollment is
usable only against an isolated local/staging endpoint, or against the private pilot project once `ZeroTouchEnrollmentApproved` is flipped by a
reviewed change.

## Recommended merge order (nothing below is done by this PR)

1. **Do not merge any PR while a flag above is true.** Each PR is stacked; merging bottom-up with flags on would ship the pilots.
2. Bottom-up, one PR at a time, retargeting each next PR to `main` after its base merged: #53 → #54 → #55 → #56.
3. In **each** PR, immediately before its merge: a commit that sets the flags *introduced by that PR* to `false` (and updates the two tests that assert
   `true` — `tests/companion-account/FeatureGateTests.cs` lines asserting the pilot flags — to assert `false`), then run
   `python3 scripts/check-pilot-flags.py --require-off` on the exact merge commit; it must print `OK`.
4. Owner pilot work continues on the stacked branches (flags on); only the *merge* commits flip them. A pilot build must never be produced from `main`.
5. Database order is independent of the PR order and owner-approved only: `0012` (already applied to the private project per the owner) → `0014`
   (not applied). `0010` stays reserved. The 0014 pre-flight refuses a database without 0012 and a ledger that already shows it.
6. Vercel: PRs #53/#56 change `web/`; the protected Preview keeps working because account routes stay behind `ACCOUNT_AUTH_MODE` (disabled by
   default) and no environment variable, DNS or Vercel setting is changed by this PR. Do not promote to `release`.
7. After the last merge: run the owner acceptance in [acceptance-zero-touch.md](acceptance-zero-touch.md) against **staging**, then decide separately
   on any production activation (flip `ZeroTouchEnrollmentApproved`, apply 0014 with the runbook below).

## 0014 deployment and recovery (owner-run, not performed)

* Backup/branch first; apply `database/migrations/0014_zero_touch_enrollment.sql` as the migration role in one transaction (it self-verifies and
  aborts on any failed assertion). It creates three private tables and fifteen functions; it changes no existing object.
* Kill switch (instant, non-destructive): `database/rollback/0014_kill_switch.sql`; lift with `0014_kill_switch_restore.sql`.
* Rollback: `database/rollback/0014_rollback.sql` drops the functions, keeps non-empty tables, never changes ownership or history.
* Monitoring queries: refusal rates `select detail, count(*) from private.device_audit where event = 'enroll_refused' and at > now() - interval '1 day' group by 1;`,
  reuse `... event = 'credential_reuse'`.

## Update 2026-10-16 — #57/#58/#59 and the safe sequence (nothing here is done; every merge needs explicit owner authorization)

Facts read from git on 2026-10-16 (all six PRs are still **draft**, nothing merged):

| PR | Base | Relation |
| --- | --- | --- |
| #53 → #54 → #55 → #56 | `main` → … → #55 branch | unchanged chain; each is 0 commits behind its base |
| #59 (web `strict-origin` fix) | #56 branch (`0decdf7`) | stacked on #56; web + docs only |
| this branch (Companion row-state fix, `claude/awesome-cerf-as0jyk`) | #59 head `ae3e20e` | Companion + one test file + docs; **no PR opened** |
| #57 (owner-only pilot) | #56 branch at `aa63f97`, i.e. one docs-only commit behind #56 | **never merge**; merges cleanly with #59, irrelevant |
| #58 (AzerDex welcome email, migration 0015) | `main` | independent of the chain; `git merge-tree` against this branch is conflict-free |

Sequence (the order is what keeps every intermediate state safe):

1. **Owner decision first.** No PR is marked ready or merged without it. Pilot flags `PrivateProjectPilotApproved`, `PrivateProjectClaimPilotApproved`,
   `SINGLE_PROJECT_PILOT_APPROVED` are still **true** (`scripts/check-pilot-flags.py`), so nothing in the chain is mergeable as it stands; the per-PR
   flag-flip commit and the `--require-off` gate above still apply exactly as written.
2. Land the two fixes **inside the #56 stack, before #56 reaches `main`**: this branch → #59 branch → #56 branch (each a merge into the stacked branch, not into `main`).
   Merging #59 into `main` directly would be wrong (it depends on #56).
3. Chain bottom-up: #53 → #54 → #55 → #56, retargeting each next PR to `main` after its base merged.
4. #57 is closed unmerged once the owner has no further pilot use. If the owner wants the row fix seen on Windows first, an owner-only build of #57 **plus** this
   fix is needed (a new commit on the #57 branch and an installer rebuild; no new activation ticket — the device credential already exists on the test profile).
5. #58 is not part of the chain. Land it **after** #56 so `0014` (reserved by #56) precedes `0015` in the repo; its own gates (G-2…G-7, B-1) are separate and OPEN.
6. Database: `0014` was **reported as already applied to the private project** (#57 body, owner acceptance 2026-10-16); the "(not applied)" wording in this
   file's earlier sections predates that and was not re-verified here. Do not apply, re-apply or alter anything as part of merging.
