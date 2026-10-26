# Account V1 release integration — 2026-10-16

Scope: integrate the stacked account PRs into `main` with **every temporary pilot approval flag OFF**. No Production deployment, no Supabase
migration or data change, no public registration, no outbound email, no AutoSync, no activation ticket was used by this integration.

## Flags (verified by `python3 scripts/check-pilot-flags.py --require-off` → `OK` on the merged head)

| Flag | Before | Now |
| --- | --- | --- |
| `SINGLE_PROJECT_PILOT_APPROVED` (web, #53) | true | **false** |
| `PrivateProjectPilotApproved` (Companion, #54) | true | **false** |
| `PrivateProjectClaimPilotApproved` (Companion, #55) | true | **false** |
| `ProductionAccountAuthApproved`, `PRODUCTION_ACCOUNT_AUTH_APPROVED`, `ZeroTouchEnrollmentApproved`, `DeviceAutoSyncApproved` | false | false |

Tests that exercised the pilot paths now inject the approval through a pure seam (web: `evaluateAccountAuth(..., approval)`; Companion:
`AccountFeatureGate.Evaluate(getVariable, GateApprovals)`), which the runtime never uses. Dedicated tests pin the closed compiled default. The
owner-only #57 pilot branch is untouched and unmerged; any future pilot build needs its own owner-approved code change.

## Integration order

#60 → #59 → #56 (fast-forward, history preserved) · #53 → #54 → #55 → #56 into `main` bottom-up with merge commits, each after its own
flag-revert commit and CI on the exact head. #57 stays open/owner-only. #58 audited separately (see its section below).

## PR #58 (AzerDex welcome email, migration `0015`) — audited separately: **NOT merged**

Code-side evidence is strong (CI on `ae592ac`: 15 success + 1 skipped `Supabase Preview`; Worker 32/32, SQL/GoTrue 67/67, Account suite 219/219; two review rounds).
Its **own** release gates are not satisfied, so the owner's condition for merging is not met: **G-2** (provenance rule on the hosted Auth version), **G-3**
(hosted staging), **G-4** (template + CID in one real send), **G-6** (two explicit approvals), **B-1** (anonymous reachability of `https://azerdex.com/`; Vercel
Authentication is on) and the hosted half of **G-7** are all OPEN in `docs/azerdex-welcome-email/acceptance.md`. G-1 and G-5 only are PASS (G-5 owner-attested).
It stays an open draft; applying `0015`, deploying the function and sending any email remain owner-only. Re-audit after the account stack lands (it is
conflict-free against this stack).

## Migration ledger evidence (repository-recorded; nothing was verified or changed live in this integration)

| Migration | Evidence in repo | State |
| --- | --- | --- |
| `0011` observed-rate denominator | `docs/f3-observed-rate-denominator.md`, `DATA_MODEL.md`: ledger `20261010151518` | applied (owner record) |
| `0012` ownership/claims | `0012-deployment-and-recovery.md`: ledger `20261012124839`, applied to the private project | applied (owner record) |
| `0014` zero-touch enrollment | #57 body and the 2026-10-16 owner acceptance say it is deployed; **no ledger version is recorded in the repo** | **owner to record the ledger version**; not re-verified here |
| `0015` AzerDex welcome outbox (#58) | not applied anywhere | not applied |
| `0010`, `0013` | reserved/unused (`0013` is the 0012 restore) | not applied |

## Remaining owner-only actions (not done, not authorized here)

Hosted-Auth/Production activation of any account flag; Production deployment (`release`); applying `0015`; recording the `0014` ledger version;
non-empty device ingest test and the 6 / 140 / 46 preservation queries (`zero-touch-pilot-closure.md` §4); Z4–Z10; Z13 one-download installer;
Windows on-screen confirmation of the device-row fix.
