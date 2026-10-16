# Browser Pairing V1 — migration and rollback plan

## Numbering and dependency

The implementation migration is `database/migrations/0016_browser_pairing.sql`. PR #58 already reserves 0015 for
`0015_azerdex_welcome_outbox.sql`; Browser Pairing must not reuse or renumber it. Migration 0016 requires 0012 and 0014 and is otherwise
independent of 0015. Tests must apply 0014/0015/0016 in production ledger order and prove that an unmerged 0015 cannot cause 0016 to be
mistakenly recorded or skipped.

Nothing in Stage A applies the migration. Any staging or live application is a separate owner-approved operation.

## Forward migration

The transaction will:

1. Preflight required schemas, Account V1 functions/tables/constraints, Auth session columns, cryptographic functions, role privileges,
   ledger state and absence of conflicting object names. It will hash and later compare protected existing function definitions/ACLs.
2. Create `private.device_pairing_config` with `enabled = false`, `private.device_pairings` and the dedicated
   `private.device_pairing_audit` with FORCE RLS, no policies and no client table privileges. Keep `private.account_audit` and its event
   constraint unchanged. The pairing audit has the exact event/column/uniqueness contract in the state-machine specification.
4. Add nullable `pairing_id` provenance to `private.devices`; make `ticket_id` nullable; add an exactly-one-source check and unique pairing
   index. Validate existing rows before validating the new check.
5. Keep `private.account_installations`, its two-foreign-key shape and claim-only provenance unchanged. Add `previous_owner_uid` to the
   pairing row and populate it atomically when an anonymous installation transfers.
6. Add a private devices trigger which changes a connected pairing to revoked whenever its provenance device becomes revoked, covering
   every existing and future revocation path without rewriting migration 0014 functions.
7. Create private helpers for config, secret matching, expiry and atomic redemption. Reuse the existing Account V1 caller and session
   guards instead of copying authorization logic where signatures permit.
8. Create six public RPCs: device start/poll/cancel and account preview/approve/deny. Revoke all first, then grant only EXECUTE to
   `authenticated`; anonymous Supabase users carry that PostgREST role but are separated by caller guards.
9. Set fixed empty search paths, volatility, row security and bounded lock/statement timeouts. Reload PostgREST schema.
10. Run postconditions: private table closure, exact function registry/ACLs, config false, old ticket/claim rows unchanged,
    ownership/data hashes unchanged, and existing 0012/0014 function definitions unchanged.

The migration does not backfill pairings, create devices, change installation ownership or enable any flag.

## Operations and gates

Future implementation will add:

- `database/ops/0016_record_migration_ledger.sql` — append-only recorder accepting exactly `browser_pairing`,
  `rollback_browser_pairing` and `browser_pairing_restore`, with object-state and predecessor-entry checks;
- `database/ops/0016_enable_browser_pairing.sql` — explicit preflighted enable, not executed by CI/deploy automatically;
- `database/ops/0016_disable_browser_pairing.sql` — immediate config kill switch;
- `database/rollback/0016_kill_switch.sql` and `_restore.sql` — revoke/restore RPC EXECUTE and force config off;
- `database/rollback/0016_rollback.sql` — remove callable objects safely while preserving nonempty registry/audit rows.
- `database/restore/0016_browser_pairing_restore.sql` — after a completed, ledger-recorded rollback, reconstruct either the complete
  empty schema or only the callable surface against a verified complete retained schema; it never rewrites an existing ledger entry.

Source gates remain false even if a disposable database gate is enabled for tests. Production enablement requires an exact migration
SHA, full acceptance evidence, security/architecture approval and owner go/no-go.

## Rollback behavior

The first response to a defect is the kill switch: set config false and revoke all pairing RPCs. Existing connected devices continue to
use the 0014 status/ingest/revocation functions unless the owner separately disables those functions.

The rollback script first snapshots counts and stable hashes for installations, owners, observations, Guildbook, tickets, claims,
devices, pairings and pairing audit, then revokes and drops the six pairing RPCs and API-only helpers. It has exactly two permitted
schema outcomes:

1. **Completely empty:** when there are no pairing, pairing-audit or pairing-provenance device rows, it may drop the integrity trigger,
   pairing-only device column/constraint, config, pairing and pairing-audit tables, and restore the original 0014 constraint shape.
2. **Any history retained:** when any such row exists, it retains the complete 0016 schema, device provenance column/constraint,
   private audit, and revocation trigger. Only the public callable surface and API-only helpers are removed. The config stays false,
   private tables remain closed, and an existing 0014 device revocation continues to update its pairing state while the API is absent.

A mixed or partly removed schema fails rollback and restore preflight. Neither outcome changes `installations.owner_user_id`, deletes a
device, restores an anonymous owner, deletes audit/history, changes migration 0012 objects or rewrites the append-only ledger.

After rollback completes, operations record `rollback_browser_pairing`. The restore refuses unless `browser_pairing` and that rollback
entry exist and `browser_pairing_restore` does not. A completed restore is recorded as `browser_pairing_restore`. As with Account V1,
that three-entry cycle is single-use: another full rollback requires a newly numbered, separately reviewed restore migration and ledger
name; operational incidents should use the reversible kill switch whenever possible.

If connected pairing rows exist, rollback is intentionally partial: the API is closed and data is retained. Any ownership restoration is
an individually reviewed recovery operation using the preserved `previous_owner_uid`, never part of generic rollback.

Rollback and restore follow reverse dependency order. Disable and roll back 0016 before any 0014 or 0012 rollback. If pairing
provenance remains in devices or pairing history, generic rollback of 0014 or 0012 is blocked; it requires a separate owner-reviewed
recovery which preserves ownership, device and audit evidence. After a completed ledger-recorded 0016 rollback, the only supported
return path is `database/restore/0016_browser_pairing_restore.sql`, followed by a new append-only restore ledger record. For the empty
outcome, that restore recreates the full 0016 schema, trigger, helpers and RPCs. For retained history, it requires the complete retained
schema and live integrity trigger, verifies that each revoked provenance device already has a revoked pairing, and recreates only the
API helpers/RPCs. In both cases it leaves every row and owner untouched, restores EXECUTE grants with the gate still false, and verifies
definitions, constraints, triggers and ACLs before commit.

## Compatibility and ordering tests

- apply 0012 -> 0014 -> 0015 -> 0016 to a disposable clone;
- apply 0012 -> 0014 -> 0016 to represent the feature branch before #58 merge, then merge/apply 0015 in a disposable database and prove
  both ledger entries/object sets remain independent;
- run 0014 ticket enrollment before and after 0016;
- run 0012 claim transfer before and after 0016;
- rehearse kill switch, restore, empty rollback and nonempty retained-data rollback;
- run the explicit 0016 restore after both permitted rollback outcomes, record its new append-only ledger entry and prove schema
  reconstruction or callable recovery without row or ownership rewrites;
- revoke a connected pairing-provenance device while the API is rolled back, prove the retained trigger marks its pairing revoked, then
  restore and prove the invariant still holds;
- prove 0014/0012 rollback refuses while pairing provenance remains, then rehearse the separately reviewed reverse-order recovery;
- mutation-test missing RLS/ACL/search-path/session/lock/state/constraint checks.
