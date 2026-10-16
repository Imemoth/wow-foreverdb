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
2. Create `private.device_pairing_config` with `enabled = false` and `private.device_pairings` with FORCE RLS, no policies and no client
   table privileges.
3. Add pairing event values to audit constraints without weakening existing event validation.
4. Add nullable `pairing_id` provenance to `private.devices`; make `ticket_id` nullable; add an exactly-one-source check and unique pairing
   index. Validate existing rows before validating the new check.
5. Add nullable pairing provenance to `private.account_installations`; make `claim_id` nullable only after an exactly-one-source check is
   installed and existing claim rows are verified.
6. Create private helpers for config, secret matching, expiry and atomic redemption. Reuse the existing Account V1 caller and session
   guards instead of copying authorization logic where signatures permit.
7. Create six public RPCs: device start/poll/cancel and account preview/approve/deny. Revoke all first, then grant only EXECUTE to
   `authenticated`; anonymous Supabase users carry that PostgREST role but are separated by caller guards.
8. Set fixed empty search paths, volatility, row security and bounded lock/statement timeouts. Reload PostgREST schema.
9. Run postconditions: private table closure, exact function registry/ACLs, config false, old ticket/claim rows unchanged, ownership/data
   hashes unchanged, existing 0012/0014 functions unchanged except the deliberately extended device-revoke provenance update.

The migration does not backfill pairings, create devices, change installation ownership or enable any flag.

## Operations and gates

Future implementation will add:

- `database/ops/0016_record_migration_ledger.sql` — append-only ledger recording after verified application;
- `database/ops/0016_enable_browser_pairing.sql` — explicit preflighted enable, not executed by CI/deploy automatically;
- `database/ops/0016_disable_browser_pairing.sql` — immediate config kill switch;
- `database/rollback/0016_kill_switch.sql` and `_restore.sql` — revoke/restore RPC EXECUTE and force config off;
- `database/rollback/0016_rollback.sql` — remove callable objects safely while preserving nonempty registry/audit rows.

Source gates remain false even if a disposable database gate is enabled for tests. Production enablement requires an exact migration
SHA, full acceptance evidence, security/architecture approval and owner go/no-go.

## Rollback behavior

The first response to a defect is the kill switch: set config false and revoke all pairing RPCs. Existing connected devices continue to
use the 0014 status/ingest/revocation functions unless the owner separately disables those functions.

The rollback script:

- snapshots counts and stable hashes for installations, owners, observations, Guildbook, tickets, claims, devices and provenance;
- revokes and drops only the six pairing RPCs and pairing-only helpers;
- removes pairing-specific constraints/columns only when no pairing/link/device row depends on them;
- drops pairing tables only when empty; otherwise retains them closed for audit/reapplication;
- never changes `installations.owner_user_id`, deletes a device, restores an anonymous owner or deletes historical data automatically;
- restores the original 0012/0014 constraint shapes only when data proves that is lossless;
- leaves the migration ledger append-only and reports the required separate recovery action.

If connected pairing rows exist, rollback is intentionally partial: the API is closed and data is retained. Any ownership restoration is
an individually reviewed recovery operation using the preserved `previous_owner_uid`, never part of generic rollback.

## Compatibility and ordering tests

- apply 0012 -> 0014 -> 0015 -> 0016 to a disposable clone;
- apply 0012 -> 0014 -> 0016 to represent the feature branch before #58 merge, then merge/apply 0015 in a disposable database and prove
  both ledger entries/object sets remain independent;
- run 0014 ticket enrollment before and after 0016;
- run 0012 claim transfer before and after 0016;
- rehearse kill switch, restore, empty rollback and nonempty retained-data rollback;
- reapply 0016 after a retained-data rollback and prove idempotent reconnection;
- mutation-test missing RLS/ACL/search-path/session/lock/state/constraint checks.
