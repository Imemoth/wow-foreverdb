# Guildbook local-only: server deployment runbook for migration 0018

**Status: a procedure for review. NOT executed. Nothing in this document may be run against the production project without separate, explicit,
written authorisation from the project owner for that specific step.** The repository, CI and any AI assistant only ever touch disposable
databases. Staging is fine to use freely; "production" below means the live Supabase project that real Companions upload to.

Owner policy (final): Guildbook data stays exclusively on the user's computer. No Guildbook cloud upload, download, backup, sync or RPC.

What the migration does and why it is shaped this way is written in the header of `database/migrations/0018_disable_guildbook_cloud_sync.sql`.
In one paragraph: it puts an observation-only projection in front of the private legacy ingest body (so every client version, old or new,
stops persisting Guildbook), it revokes EXECUTE on every `public` function with `guildbook` in its name, it records a one-row marker table, and it
changes no row. Historical rows are removed only by the separate, owner-run [cleanup](historical-guildbook-data.md).

## 0. Decisions the owner must make before step 1

| # | Decision | Default recommended here |
|---|----------|--------------------------|
| D1 | Apply 0018 before, together with, or after the new Companion release? | Before or together. The server change is backwards compatible with old Companions (they keep uploading observations; their Guildbook is silently dropped). |
| D2 | Delete the historical cloud Guildbook after 0018? | Yes, as a separate step after a verified backup (see the historical-data document). 0018 alone does not delete anything. |
| D3 | The installation list RPC still returns a per-installation Guildbook **count** (`guild_count`) until D2 is executed. Accept that interim state? | Accept, then execute D2 promptly. Redefining that RPC is a change to the linted account migration set and is deliberately not part of 0018. |
| D4 | Keep the Guildbook export (backup) for how long? | The shortest period that covers rollback and a possible access request, then destroy it. Write the date down. |

## 1. Pre-flight (read-only; staging, then production only with authorisation)

Run with a read-only connection. Nothing below prints a name, guid, installation id or e-mail address.

1. **Ledger**: 0011, 0012, 0014 and 0015 are recorded, 0018 is not.
   ```sql
   select version, name from supabase_migrations.schema_migrations
   where name in ('fix_observed_drop_rate_denominator','account_ownership_claims','zero_touch_enrollment',
                  'azerdex_welcome_outbox','disable_guildbook_cloud_sync') order by version;
   ```
2. **Legacy ingest present and original** (the source text is not printed, only booleans):
   ```sql
   select to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is not null           as impl_present,
          to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null          as legacy_name_free,
          (select prosrc like '%pg_advisory_xact_lock%' and prosrc like '%Installation belongs to another authenticated client%'
             from pg_proc where oid = to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)')) as impl_is_original;
   ```
   All three must be `true`. Anything else: stop; the migration would refuse anyway.
3. **Current grants** (expected before 0018: `authenticated` can execute both read RPCs):
   ```sql
   select p.oid::regprocedure::text as fn,
          has_function_privilege('anon', p.oid, 'execute') as anon_x, has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
          has_function_privilege('service_role', p.oid, 'execute') as svc_x
   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~* 'guildbook';
   ```
4. **Counts, dates, owner classes and "is anything still uploading"**: run `database/ops/guildbook_historical_inventory.sql` and keep the output privately.
   Read `installations_with_guild_rows_updated last_24h / last_7d` and `recent_guild_uploaders`: non-zero means Companions that still
   send Guildbook are in the field (that is the compatibility risk 0018 absorbs; it is not a reason to wait).
5. **Role and timeouts**: the session is the migration role that owns the existing functions (the pre-flight in the migration checks ownership), and
   `PGOPTIONS='-c lock_timeout=10s'` is set. The migration takes short catalog locks only (function rename / replace) and reads the three Guildbook
   tables once to fingerprint them: on a large installation set that scan takes seconds, not minutes.
6. **Staging parity**: the staging project is on the same migrations as production (0012, 0014, 0015) and was used for section 4 first.

## 2. Backup (before any production step, and mandatory before the cleanup)

1. In the Supabase dashboard (Database > Backups) confirm which protection the project plan provides: daily backup and its retention, and Point-in-Time
   Recovery if the add-on is enabled. Write down the latest restore point (timestamp) and its retention. If there is **no** backup, stop and decide D4/plan first.
2. **Table-level export of exactly the three Guildbook tables** to an encrypted, private location, never into the repository, GitHub, CI artifacts,
   a synced consumer-cloud folder, a chat or a ticket:
   ```bash
   # DATABASE_URL comes from the owner's secret store; do not paste it into shell history or a file in the repo.
   pg_dump "$DATABASE_URL" --no-owner --format=custom \
     --table=public.installation_guilds --table=public.installation_guild_members --table=public.installation_guild_professions \
     --file guildbook-export.dump
   # encrypt immediately with a tool whose key only the owner holds (age, gpg or an AES-256 archive), then remove the plaintext dump
   ```
3. Record **in the change record, not in the repository**: the encrypted file's SHA-256, its size, the row counts from the inventory (`guild_rows`,
   `member_rows`, `profession_rows`), the date, the storage location class ("owner laptop, encrypted volume") and the planned destruction date (D4).
   This record is what `-v backup_ref=...` of the cleanup script refers to.
4. **Prove the backup restores**: restore the encrypted export into a scratch database and compare the three counts with the inventory. An unrestorable
   backup is not a backup.
5. The export contains other players' character names, ranks, zones and professions. Treat it as personal data under the project's GDPR documents
   (`docs/gdpr/`): minimal access, no copies, destroy on the planned date.

## 3. Apply

Only after sections 1 and 2 passed and the owner authorised this step in writing (reference number in the change record).

1. **Staging first.** Apply `database/migrations/0018_disable_guildbook_cloud_sync.sql` through the project's normal migration tool (for example the Supabase
   `apply_migration`, which also records the ledger entry `disable_guildbook_cloud_sync`). When applying with `psql` instead, add the ledger row
   yourself, append-only, with a version newer than every existing one. The migration itself never writes the ledger, and a second run is refused
   by its pre-flight once the ledger shows it.
2. Run section 4 completely on staging. Only then repeat sections 1 to 4 on production (a separate authorisation).
3. The migration is one transaction: if any post-condition fails, nothing is applied. A failure message beginning `0018 pre-flight` or
   `0018 post-condition` is a stop; do not edit the file to make it pass.
4. Apply the new Companion build and the web change at their own pace (D1); this migration does not depend on them.

## 4. Post-checks

All read-only unless stated.

1. **Privileges**: re-run the pre-flight query 3. Every column must be `false`.
2. **Marker and private objects**:
   ```sql
   select (select count(*) from private.guildbook_cloud_sync_guard where guard_name = 'disabled') as guard_rows,
          (select prosrc like '%fdb_public_snapshot%' from pg_proc where oid = 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure) as projection_in_front,
          bool_or(has_function_privilege(r, 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)', 'execute')
               or has_function_privilege(r, 'private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)', 'execute')
               or has_function_privilege(r, 'private.fdb_public_snapshot(jsonb)', 'execute')) as any_api_role_can_execute
   from unnest(array['public','anon','authenticated','service_role']) r;
   ```
   Expected: `1`, `true`, `false`.
3. **Nothing was lost**: the inventory counts equal the pre-flight counts (same `guild_rows`, `member_rows`, `profession_rows`).
4. **API behaviour** (staging, with a synthetic test account and its publishable key; never a real user's token): `POST /rest/v1/rpc/fdb_account_guildbook_guilds`
   and `.../fdb_account_guildbook_members` as `anon` and as the test account must be refused (HTTP 401/403 with code `42501`).
5. **Synthetic ingest with guilds** (staging only): upload a snapshot for a synthetic installation id that contains a `guilds` array through
   `ingest_foreverdb_snapshot_auth` (and, for an enrolled synthetic device, `fdb_device_ingest`). Expected: `ok = true`, `guildCount = 0` in the reply, the
   installation's rows in `installation_source_stats / _item_stats / _location_stats` are present, and `installation_guilds` has no row for it.
   A synthetic installation that was given a Guildbook row *before* the migration must still have exactly those rows (compare the per-installation counts
   before and after a second snapshot, including a snapshot with an older `updatedAt`, which the legacy body ignores).
6. **Observation ingest still works end to end**: a current Companion build (and, for the compatibility risk, an old one) completes a sync against staging;
   the installation's `snapshot_updated_at` advances; the API logs show no 5xx on `ingest_foreverdb_snapshot_auth` or `fdb_device_ingest`; the public
   pipeline (`publish-observations`) is unaffected because it reads aggregated statistics only.
7. **Static contract**: the web conformance tripwire and `database/tests/account/11..14` and `database/tests/enrollment/11` are green in CI for the commit being deployed.

## 5. Monitoring and the kill switch

- The migration **is** the kill switch; there is no flag to flip. Its state is the marker row plus the closed grants.
- **Weekly (first month), then monthly** (add to the owner's routine): the three queries below must show no growth.
  ```sql
  -- rows written after activation (preserved rows keep their original updated_at): must be 0
  select count(*) from public.installation_guilds g, private.guildbook_cloud_sync_guard k where g.updated_at > k.activated_at;
  -- any API role able to execute a Guildbook function: must be 0 rows
  select p.oid::regprocedure from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname ~* 'guildbook'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
         or has_function_privilege('service_role', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
  -- ingest projection still in front: must be true
  select prosrc like '%fdb_public_snapshot%' from pg_proc where oid = 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure;
  ```
- After anything that can re-grant (`database/rollback/0012_kill_switch_restore.sql`, `database/restore/0013_*`, a hosted-project schema restore, a new
  Guildbook function in a later migration) run `database/ops/guildbook_local_only_reassert.sql`. It only revokes, refuses when the marker is absent and
  is idempotent.
- Re-running 0012 on top of 0018 is refused by 0012's own pre-flight (it pins the legacy ingest body). That is the intended fail-closed behaviour.

## 6. Rollback considerations (read before touching `database/rollback/0018_restore.sql`)

- **There is nothing to roll back for data**: 0018 deleted and changed no row.
- **Why you would almost never restore**: both parts of the restore re-open cloud handling of *other players'* character data against the owner policy.
  `scope=reads` re-opens reads of historical rows to their verified owner; `scope=ingest` removes the projection, i.e. old Companions can upload Guildbook
  again and every snapshot rewrites the installation's Guildbook rows (the pre-0018 behaviour).
- **If ingest of observations breaks after 0018** (the realistic emergency): first check the pre-flight booleans and the API logs. The wrapper's only
  additional work is the preservation of existing rows. If that is the cause, the safe hotfix is a **new forward migration** (next free number, with its own
  ledger name) that replaces the wrapper by a strip-only variant without the preservation step (observations keep flowing, no Guildbook is persisted). The price
  is that existing historical rows of an installation are then rebuilt-away by the next snapshot (the legacy body deletes them): take the table-level
  export of section 2 first, and decide whether to run the cleanup right away anyway. `0018_restore.sql scope=ingest` is the last resort because it
  also re-enables Guildbook writes.
- **If you must restore**: written owner approval first; `psql -X -v ON_ERROR_STOP=1 -v confirm='REOPEN-GUILDBOOK-CLOUD-PATHS' -v scope=<reads|ingest|all> -v operator='<name>'
  -v approval_ref='<reference>' -f database/rollback/0018_restore.sql`. It refuses without every variable, does not write the ledger, deletes no row, never grants
  `public`, `anon` or `service_role`, and refuses `scope=ingest` when account-scoped Guildbook tables exist. With a real ledger the 0018 body cannot be re-run
  (its pre-flight refuses a second run), so re-closing after a restore is `database/ops/guildbook_local_only_reassert.sql` (grants) plus a new forward
  migration for the projection.
- A restore that changes the marker (`scope=ingest|all` deletes the guard row) must be followed, as soon as the reason is gone, by re-closing and by recording
  the incident per `docs/gdpr/incident-response-runbook.md` if Guildbook rows were readable or writable in the meantime.

## 7. Ordering with other migrations

- **0015 (welcome outbox)** is independent of 0018 (neither references the other); both orders are exercised in `database/tests/account/12_*` and end in the same
  privilege state. 0014 and 0015 may be re-applied after 0018 (idempotent). 0012 and `database/restore/0013_*` must not be re-applied after 0018 (see section 5).
- **The sibling branch's migrations (absent from this one):** 0016 (account-scoped cloud Guildbook) is **permanently retired** and must not be merged in any form; 0017 (independent collectors) is a separate subject, not part of this deployment, and is judged by what it does (the CI guard checks content, not the number: `migration-policy-enforcement.md`). If they ever land, read `docs/guildbook-local-only/db-changes.md` section 4 first: 0017 is neutral; 0016 must not replace
  the 0018 ingest wrapper, must not copy historical rows into private account tables and must keep every Guildbook RPC revoked.
- 0018 deliberately uses the number reserved for it; gaps in the numbering are normal in this project (0010 and 0013 are not migrations in the sequence either).

## 8. Authorisation gate (copy into the change record)

- [ ] Owner authorised **staging** application (reference: ____ )
- [ ] Pre-flight output reviewed (section 1), including `recent_guild_uploaders`
- [ ] Backup verified and recorded (section 2): restore point, encrypted export SHA-256, scratch-restore counts, destruction date
- [ ] Owner authorised **production** application of 0018 (reference: ____ ) - separate from staging
- [ ] Post-checks (section 4) recorded
- [ ] Owner authorised the **cleanup** (reference: ____ ) - separate again, see `historical-guildbook-data.md`
- [ ] Monitoring routine (section 5) scheduled

**No step in this runbook is to be executed on production by anyone, including an assistant or CI, without the matching checked and referenced line above.**
