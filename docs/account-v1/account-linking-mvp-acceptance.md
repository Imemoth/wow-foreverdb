# Account linking MVP acceptance record

Date: 2026-10-20

Target: October 30, 2026

Branch: `feature/account-linking-mvp`

## Release behavior

- Anonymous Companion use remains available and unchanged.
- A user with an existing confirmed ForeverDB account can sign in inside the Companion, prove control of the current anonymous installation, transfer that installation through the existing Account V1 claim RPCs, and register the local Companion through the existing device-enrollment RPCs.
- The installation ID, historical observations and Guildbook relationships are preserved by the existing database ownership transfer.
- The website claim-code flow remains available as a recovery path. `.fdbact` support is preserved, while production activation-file discovery remains disabled.
- Account access/refresh tokens and device credentials remain in the existing Windows DPAPI stores. Claim and enrollment secrets exist only in process memory and are not placed in URLs or logs.
- Standard Companion account sign-in/direct linking is enabled for owner acceptance. AutoSync, activation-file enrollment, web production activation and temporary pilot/claim gates remain off.

## Focused security review

The completed authentication and ownership diff was reviewed for credential boundaries, replay, account switching, failure recovery, local storage and takeover resistance.

One material issue was found during review: the first implementation could transfer ownership before discovering that the computer already held a device credential for a different installation. A failing regression test reproduced the condition. The implementation now validates the device store and installation binding before claim creation, so the ownership transfer is not attempted in that state.

The final flow keeps these boundaries:

- The anonymous owner JWT can only start the claim after the database confirms the live session and current owner.
- The registered user JWT redeems the one-time claim and issues the enrollment ticket.
- A separate anonymous device JWT redeems that ticket; the returned device secret is stored through DPAPI.
- Installation ID knowledge alone cannot start a claim or transfer ownership.
- A revoked registered session fails before ownership transfer.
- Lost write responses are reconciled through read-only status and are not blindly replayed.
- The native client calls a fixed RPC allowlist and contains no generic proxy or service-role credential.
- Existing database rate limits, single-use locks, device limits and revocation checks remain authoritative.

No unresolved Critical, High or Medium finding remains in the scoped ownership diff. Before public rollout, the owner must complete hands-on acceptance of the normal Windows package and confirm the hosted GoTrue abuse/rate-limit configuration. This branch changes no hosted setting.

## Verification evidence

Local verification on the feature branch completed with:

- Companion Account tests: 582 passed, 3 skipped on Linux because they exercise Windows DPAPI; the Windows CI gate requires zero skipped tests and explicitly checks the real-DPAPI and multi-process cases.
- Companion WPF Release build: passed with zero warnings and zero errors.
- Account separation/static checks: passed.
- Web unit tests: 397 passed; typecheck, lint, production build and built-bundle secret scan passed.
- Disposable PostgreSQL and real GoTrue 2.197.0 vertical slice: 7 passed, including anonymous ownership proof, registered claim redemption, device ticket enrollment, device sync and rejection of the previous owner.
- Disposable database concurrency and failure-recovery regressions: 21 passed after removing test-state coupling and consuming the expected terminated-client error.
- Migration 0012/0014 ownership, replay, enrollment, logout and revocation suites passed apart from a local test-runner working-directory problem; the affected migration rollback case was rerun with the corrected wrapper and passed. Exact-head CI remains the release authority for the complete suites.
- The previous implementation head completed all eight workflows successfully. The standard-package gate change requires a fresh exact-head run before owner acceptance.

## Acceptance gates

- [x] Focused end-to-end Companion implementation and regression tests.
- [x] Anonymous use, existing installation identity, historical data and fallback enrollment preserved.
- [x] AutoSync, activation-file enrollment, web production activation and temporary pilot gates remain off.
- [x] Focused security review completed; material finding fixed test-first.
- [ ] Exact-head pull-request CI is green after the standard-package gate change.
- [ ] Windows runner executes all DPAPI and cross-process tests without skips.
- [ ] Normal `ForeverDB-Companion-win-x64` workflow artifact is produced.
- [ ] Owner acceptance on the Windows build.
- [ ] Separate authorization before any production deployment, hosted Supabase change, public activation or installer publication.

The unfinished browser-pairing/trusted-ingress work in PR #62 remains Draft and unmerged until this replacement passes its acceptance gates.
