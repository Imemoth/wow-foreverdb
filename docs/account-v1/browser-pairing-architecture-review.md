# Browser Pairing V1 — Stage A architecture review

**Review date:** 2026-10-16

**Review scope:** Stage A design, ADR, API, state machine, threat model, migration/rollback and acceptance matrix.

**Result:** No Critical finding and no substantive blocker to preparing Stage B. All High and Medium findings are resolved in the
normative Stage A documents. Feature gates remain off; this conclusion does not approve implementation deployment or activation.

## Resolved findings

| Area | Resolution frozen for Stage B |
| --- | --- |
| Migration and restore compatibility | Migration 0016 does not alter migration 0012 tables. A nonempty rollback retains the complete schema and revocation trigger; an empty rollback may remove it. The explicit 0016 restore verifies/reopens retained schema or rebuilds empty schema without rewriting the append-only ledger. Reverse dependency order blocks 0014/0012 rollback while pairing provenance remains. |
| Registered-device re-enrollment | An active device must first be revoked. The latest predecessor must match installation, current account and initiating anonymous UID, and have reason `owner_revoked`, `credential_reuse` or `replaced`. Redemption rechecks under lock and inserts a new device. |
| Approving browser authorization | Approval stores the exact registered UID and session ID. Redemption revalidates that session; logout, password reset, expiry or revocation terminally denies without transferring ownership. |
| Redemption failures | Account/device limits remain approved and retryable until expiry. Account/session, ownership, predecessor and device-ID collisions terminally deny. Gate, rate and temporary infrastructure failures do not mutate pairing state. |
| Device revocation propagation | A devices-table trigger propagates every revocation cause to the connected pairing row, including owner action, credential reuse and replacement. |
| Lock and throttle ordering | One global order covers abuse budgets, installation/session/pairing/account/device locks. Invalid locator, actor or secret cannot mutate pairing-specific throttle or schedule state. |
| Atomic ownership | Two valid polls can commit one ownership change, previous-owner provenance row value, one device and one success audit. Replays are read-only. Concurrency and mutation tests cover every boundary. |
| Audit contract | A dedicated closed pairing audit uses a nonpublic reference and seven fixed events. Transition rows are unique, deferred-limit rows are bounded by reason, and invalid or infrastructure requests never create pairing audit. Migration 0012 audit remains unchanged. |

## Residual security and ownership decisions

No unresolved ownership-authority decision remains: `public.installations.owner_user_id` is the only authority, and a registered
installation cannot switch accounts through pairing.

The following residual risks are accepted design constraints and require verification rather than another architecture decision:

1. A holder of a live locator can make a browser select that request and can attempt nuisance denial or approval phishing. The locator
   cannot redeem; the named-account approval, CSRF controls and initiating Companion proof remain required.
2. A stolen live anonymous bearer can start a new pairing using attacker-chosen secrets. It still needs visible browser approval. The
   protocol authenticates the Supabase session and local proof, not the identity of the executable process.
3. For a previously anonymous installation, the server cannot infer a different intended registered account. The account shown on the
   confirmation screen becomes owner only after explicit approval and proof-bearing redemption.
4. Malware running as the same Windows user may access the DPAPI-protected material. Hardware attestation and protection from a fully
   compromised user session remain outside V1.

These constraints do not introduce a second ownership authority or permit silent transfer. Stage B may proceed after the Stage A
written specification is reviewed, while all source and database gates remain off.
