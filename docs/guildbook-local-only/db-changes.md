# Guildbook local-only: database changes (RC branch `fix/guildbook-local-only-rc`)

Server-side kill switch for the Guildbook cloud paths on the **RC migration set** (0001..0009, 0011, 0012, 0014, 0015). Reference implementation: PR #112,
branch `origin/feature/guildbook-local-only` (tip `ecb570ff`). The RC does **not** contain that branch's 0016 (account-scoped Guildbook cloud ingest) or 0017
(account-independent collectors) and must not get them. **Nothing here was executed against PostgreSQL**: no `psql`/Docker was available while writing it. Correctness rests
on reading against the RC migrations; CI is the first real run.

## 1. What was reused, adapted and excluded

| Item from #112 | Disposition | Why / what changed |
|----------------|-------------|--------------------|
| `migrations/0018_disable_guildbook_cloud_sync.sql` | **Adapted** | Same design (wrapper + revoke sweep + marker table), plus: stale-snapshot fix (`on conflict do nothing`), advisory lock before the copy, no temp tables when the installation has no Guildbook rows, legacy function ACL closed, pre-flight proves the wrapped body is the original (not just present), post-conditions fingerprint every other function and all Guildbook rows, sweep pattern `guildbook` (case-insensitive) instead of one prefix, file never spells the account function names (see section 3). Uses number 0018 (reserved); 0016/0017 stay reserved for the other branch. |
| `rollback/0018_restore.sql` | **Rewritten** | #112's script could only run when the guard was absent (a no-op on a real database) and granted every matching signature. Now: refuses without the exact confirmation, scope, operator and approval reference; scopes `reads` / `ingest` / `all`; grants only the two 0012 signatures to `authenticated`; `ingest` restores the original body and deletes the guard row; refuses `ingest` when account-scoped tables exist. |
| `tests/account/11_legacy_guildbook_paths.test.mjs` | **Adapted** (same name) | Runs on a clone; adds stale-snapshot, mid-snapshot rollback, intruder, payload-bounds, projection, guard, static-file and refusal tests. |
| `tests/account/12_guildbook_migration_order.test.mjs` | **Rewritten** | Orders are the RC's (0012>0014>0015>0018, ...>0018>0015, 0012>0018>0014>0015), CI-layout aware, fingerprint equality, re-apply behaviour. #112's version drives 0016/0017. |
| `tests/enrollment/12_guildbook_cloud_disabled.test.mjs` | **Adapted** as `tests/enrollment/11_guildbook_cloud_disabled.test.mjs` | On a clone (the shared DB never gets 0018); RC allows one live device per identity, so each installation gets its own device; adds the unchanged-0014-checks and oversize/malformed payload cases. |
| `tests/account/10_account_scoped_guildbook.test.mjs`, `tests/enrollment/11_independent_collectors.test.mjs` | **Excluded** | They test 0016 and 0017. |
| `0016_account_scoped_guildbook.sql`, `0017_account_independent_collectors.sql` | **Excluded** | Not in the RC; 0016 would add a second cloud copy of Guildbook (section 4). |
| `stack.sh apply16/17/18`, workflow steps that apply 0016/0017/0018 to the shared database | **Excluded** | 0018 on the shared database would invalidate the exact-function-set assertions of the 0012 and 0014 suites in every CI layout. All 0018 suites clone the database. **No workflow was changed**: the existing jobs already run `database/tests/account/*.test.mjs` and `database/tests/enrollment/*.test.mjs` in all three layouts (0012; 0012+0015; 0012+0014+0015). |
| #112 edits to `01_privileges.test.mjs` (drops the 0015 exclusion), `02_live_session.test.mjs` (filters the registry), `harness.mjs`, the `resetBudgetsInFreshWindow` removals, the e2e workflow env rename | **Not copied** | Artefacts of that branch's divergence from the RC (no 0015, a larger contract registry), unrelated to Guildbook. |
| (new) `ops/guildbook_local_only_reassert.sql`, `ops/guildbook_historical_inventory.sql`, `ops/guildbook_historical_cleanup.sql`, `tests/account/13_*`, `14_*` | **New** | Re-close after anything that re-grants; evidence and owner-run deletion of historical rows (see `historical-guildbook-data.md`). |
| (changed) `tests/account/01_privileges.test.mjs`, `tests/enrollment/01_privileges.test.mjs` | **Edited** | They enumerate private functions: the two new private functions and the retained legacy body are expected **only when the marker table exists**, i.e. only if someone applies 0018 to the shared database. |
| (changed) `tests/account/README.md` | Edited | Documents 11 to 14. |

## 2. Is the "preserve guild rows around the legacy call" step still needed and correct?

**Needed: yes.** The unmodified legacy body (0005, kept as `foreverdb_ingest_snapshot_impl_v1_legacy`) executes
`delete from installation_guild_professions / _members / installation_guilds where installation_id = ...` on every snapshot that is not stale, then re-inserts from
`p_snapshot->'guilds'` (`0005_guildbook_v1.sql:202-208, 232, 264, 316`). With `guilds` stripped, every Guildbook-free upload would silently, irreversibly and without a backup
erase that installation's historical rows, defeating the owner's decision that deletion is a separate authorised step. Editing or forking the legacy body is worse: the 0012
and 0013 pre-flights pin its text.

**Correct as in #112? No; three defects fixed:**

1. *Stale snapshot*: the legacy body returns `stale_ignored` before it deletes anything. #112's unconditional re-insert then hits a duplicate key and fails a harmless request.
   Now `on conflict do nothing` (tested: `11_*` "stale snapshot", expects `status = stale_ignored`).
2. *Race with the owner-run cleanup*: the copy happened before any lock; a concurrent cleanup could delete the rows after the copy and the re-insert would resurrect them. The
   wrapper now takes the per-installation advisory lock (same key as ingest, claims, device ingest and the cleanup script; re-entrant) before the copy. The cleanup skips, not waits for, a busy installation.
3. *Cost*: three temp tables per ingest (catalog churn) even for installations that never had Guildbook. Now one indexed `EXISTS`; the temp copy happens only when rows exist.

Atomicity is unchanged: no savepoint; any legacy failure aborts the caller's transaction and discards the copy (tested with a corrupt item id after the legacy body already deleted
the rows). Rows are copied with `select *` into a temp table of the same shape and re-inserted unchanged, so `updated_at` is preserved exactly (tested by hashing the rows including `updated_at`).
A Guildbook-free payload therefore **does not erase history**; removal is `guildbook_historical_cleanup.sql`.

## 3. `fdb_account_installations()` (returns `guild_count`)

Left unchanged, deliberately. It is owner-scoped, returns a count only (no names, guids, ranks) and stays executable by `authenticated` because the website's installation list
needs it for the ownership/enrollment feature. After the historical cleanup it returns 0. Redefining it inside 0018 is wrong for this tree: `web/tests/unit/account-migration-conformance.test.ts`
lints every migration whose text mentions an account function as one unit (it would report a duplicate definition, unregistered functions and dynamic DDL), and web files were out of scope. For
the same reason 0018 never spells those function names (it sweeps `guildbook` by regex with a bracketed pattern) and `11_*` pins that property statically. **Open decision for the owner:** if
a nonzero interim count is unacceptable, ship a follow-up that redefines the RPC to return `0::integer` together with the matching registry/linter change on the web side, or run the cleanup
promptly after 0018 (the count then reads 0). `11_*` pins today's behaviour (count only, four columns) so a change is noticed.

Also pinned by design: re-applying **0012** or `database/restore/0013_*` after 0018 is refused by their own pre-flight (they pin the legacy ingest body, which now sits under the `_legacy`
name). That is fail-closed, because both would re-grant the Guildbook read RPCs. `database/rollback/0012_kill_switch_restore.sql` has no such check and does re-grant them: run
`database/ops/guildbook_local_only_reassert.sql` afterwards. 0014 and 0015 may be re-applied after 0018 (tested).

## 4. Forward compatibility with the sibling branch's 0016 / 0017 (documentation only; not applied here)

Read from `origin/feature/guildbook-local-only` (`0016_account_scoped_guildbook.sql`, `0017_account_independent_collectors.sql`).

**0017** only drops `private.devices_one_live_per_identity` and `create or replace`s `fdb_device_enroll`. It names no Guildbook object, no `_legacy` function and no guard. It is neutral to
0018 in both orders and needs only 0014.

**0016 after 0018** ("kill first"):
- Pre-flight passes: it allows the occupied `_legacy` name when the guard row exists, and requires `fdb_device_ingest` and the two 0012 Guildbook RPCs (still present, ACL irrelevant).
- Its `$local_only_acl$` block sweeps `public.fdb_account_guildbook_%` and revokes all four roles when the guard row exists, so the new ingest/scoped RPCs it grants to `authenticated` are
  re-closed **in the same transaction**; its post-condition asserts that. **Neutralised: yes.**
- It `create or replace`s `private.fdb_public_snapshot` (identical body) and `private.foreverdb_ingest_snapshot_impl_v1`, **replacing the 0018 wrapper with its own variant** (no advisory lock, no
  `on conflict do nothing`, temp copy always). The stale-snapshot failure of section 2 comes back and the cost returns. Behaviour otherwise equals 0018 (observation-only).
- It **copies every historical Guildbook row of confirmed registered owners into `private.account_guildbook_*`** (the "deterministic compatibility transition"), unguarded by the marker.
  That creates a second cloud copy of the data the policy forbids, in tables the cleanup script does not cover (the inventory reports them; the cleanup refuses to execute while they are non-empty).

**0016 before 0018** ("full"): 0018's pre-flight passes (the `_legacy` body is the original), it replaces 0016's wrapper with the 0018 wrapper, and its catalog sweep revokes all five RPCs
(`_ingest`, `_guilds_scoped`, `_members_scoped` and the 0012 pair; every name contains `guildbook`). **Neutralised: yes.** The copied rows already exist (same gap).

**What must be true if 0016/0017 ever land on this branch** (a separate owner decision; not part of this work):
1. 0016 must not replace the 0018 wrapper when `private.guildbook_cloud_sync_guard` has the `disabled` row (or its wrapper must be made identical to 0018's: lock, `exists` probe, `on conflict do nothing`).
2. 0016's copy of historical rows into private account tables must be removed or guarded; any retained account-scoped storage must be added to the inventory and cleanup scripts (the cleanup refuses today).
3. Keep 0016's `$local_only_acl$` sweep and its post-condition; no later script may grant a function whose name contains `guildbook` (re-run `guildbook_local_only_reassert.sql` after any restore).
4. 0016 mentions account functions, so the web registry/linter must list its RPCs; the account suite's exact-function-count assertions must be reworked on that branch (`11_*`/`12_*` here already tolerate the extra functions by pattern).
5. Extend `database/tests/account/12_guildbook_migration_order.test.mjs`: add `"0016"` and `"0017"` entries to `STEPS` and orders to `SCENARIOS` (the file is table driven); the #112 version of that test covers both orders.

## 4a. CI regression guard (implemented)
`web/tests/unit/guildbook-migration-guard.test.ts` runs in the always-on web unit tests. It is CONTENT-based (it never looks at a file's name or number): it fails when any migration outside the hash-pinned reviewed set mentions Guildbook structures, the private ingest implementation, the 0018 projection or marker, or builds grants dynamically; and when an already-reviewed migration (0001-0015) is edited. A renamed copy of the sibling branch's 0016 is therefore caught exactly like the original (**0016 is permanently retired**), while 0017 (independent collectors) is judged only by what it does and is not blocked by its number. Full analysis of how the guard itself could be bypassed, and what needs GitHub ruleset / code-owner settings: `migration-policy-enforcement.md`. It also pins the properties of 0018 itself (strip-before-persist, catalog revoke sweep, no delete/truncate, refusal messages, marker table) and the fail-closed form of the restore/reassert/cleanup guards. `guildbook-approval-pins.test.ts` pins the content hashes the owner approves (see 0018-approval-checklist.md). This is a review-time guard, not a database-level one: a migration applied by hand outside the repository is not stopped; the post-apply inventory check in the checklist (section E) is what catches that.

## 5. Not verified / risks

- No SQL was executed. PL/pgSQL syntax, `psql` meta-command behaviour (`\if`, `\gset`, `begin read only` via `\if`), the temp-table plan-cache behaviour inside the wrapper, and every test expectation were checked by reading only.
- `12_*` compares ACL/body fingerprints of the three orders; the ACL text could differ for a reason not foreseen (for example grant order on a function touched by two migrations). It would fail loudly, not silently.
- In CI layouts that already contain 0015 (or 0014) the three orders partly collapse (a migration present on the clone is skipped); every order still ends with 0018 applied and is compared.
- The shared-DB suites and the web unit/e2e jobs are unchanged; the e2e stack (`web/tests/e2e-stack`, applies through 0012) still runs the legacy Guildbook path and any Playwright test that reads Guildbook through the RPCs belongs to the web engineer.
- Supabase specifics not reproducible here: the real `postgres` role's TEMP privilege and ownership of `private.*` (assumed, as 0012 assumes), and how PostgREST maps `42501` (documented as 401/403).
