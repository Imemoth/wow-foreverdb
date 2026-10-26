# ForeverDB private Guildbook cloud kill switch — staged release review

**Scope:** private Supabase `wow-forever` (`klxhikdlfwgxurdyexdi`), not the independent public-read Supabase project. The user approved **local-only Guildbook**. Public AzerDex V1 + Account and beta must stay operational.

## Live read-only preflight on 2026-10-26

- Private schema contains `public.fdb_account_guildbook_guilds(text)` and `public.fdb_account_guildbook_members(text,text,integer,integer)`, both owned by `postgres`, `SECURITY DEFINER`, and `EXECUTE`-granted to `authenticated`.
- `private.foreverdb_ingest_snapshot_impl_v1(jsonb)`, `public.ingest_foreverdb_snapshot_auth(jsonb)` and `public.fdb_device_ingest(text,jsonb)` are present.
- `private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)`, `private.fdb_public_snapshot(jsonb)`, and `private.guildbook_cloud_sync_guard` are absent (the expected pre-0018 state).
- Historical Guildbook data counts: `installation_guilds=0`, `installation_guild_members=0`, `installation_guild_professions=0`; independent observation counts: `installation_source_stats=167`, `installation_location_stats=615`, `installation_item_stats=395`, and `installations=9`. These counts may increase through normal ingestion; they are NOT a data-retention limit or promise of no concurrent writes.
- Supabase live migration history contains 0012, 0014, 0015 but no 0016/0017/0018; those are still pending in the separate Companion/Account feature chain.

All counts above are metadata only: no Guildbook/character/member data, credentials, or token values were exported.

## What this isolated PR adds

- Identical upstream `database/migrations/0018_disable_guildbook_cloud_sync.sql` from Companion local-only PR #112 (pinned to commit `b47606061e21173ac091916e100cd51988d7ba90`). **No Companion executable or broad stacked PR is merged.**
- Rehearsal of pre-0014 schema (0012) from the upstream #112 disposable database suite; additional rehearsal of **current production shape (0012 + 0014)** on a cloned disposable PostgreSQL + real-GoTrue stack.
- Operator-only `database/rollback/0018_restore.sql` as upstream historical recovery artifact. **Do not execute automatically.** It intentionally refuses to grant access while the durable local-only guard is active. It does not undo ingest projection, restore full historical behavior or delete data.

## Intended migration effects

1. Create a durable `private.guildbook_cloud_sync_guard` kill-switch marker.
2. Revoke all `EXECUTE` grants from all `public.fdb_account_guildbook_%` RPCs for `PUBLIC`, `anon`, `authenticated`, and `service_role` (while retaining function definitions).
3. Preserve the original private legacy ingest function under `*_legacy` and install a wrapper that removes Guildbook fields before ingest while preserving any existing historical Guildbook rows.
4. Keep unrelated published loot/location/source observations and existing Account, enrolled-device and public-ingest permissions intact. Only the **Guildbook-specific** cloud read/write path is disabled.
5. Retain all installations, Guildbook tables, Guildbook rows, and unrelated functions. No `DELETE`, `TRUNCATE`, or `DROP TABLE` against persistent Guildbook tables.

## Mandatory gates before applying to the private production DB

- [ ] New PR CI green, particularly **Account ownership SQL + real GoTrue**, production-shaped 0018 clone test, enrollment flows, release-gate, API-security tests.
- [ ] Reconfirm live object signatures and grant state, source hash, migration ledger (including absence of an existing 0018 entry), and the table row counts.
- [ ] Confirm expected observation ingestion and authentication are healthy immediately before the migration; preserve a rollback/restore and troubleshooting plan. If changes occurred outside expected objects, stop.
- [ ] Use a migration-recording deployment path (Supabase `apply_migration` with name `disable_guildbook_cloud_sync` or an approved equivalent). **Never execute the DDL with an untracked SQL Editor click.** The SQL body is transaction-wrapped; any failed preflight/postcondition must abort without partial effect.
- [ ] Post-migration: verify durable guard, no Guildbook RPC executable by client roles, original function still preserved as `*_legacy`, and all three historic tables/row counts retained.
- [ ] Post-migration: verify both public and enrolled-device observation ingestion still function, no private Guildbook rows are added, and the website's authenticated Account, public APIs, map/news endpoints and beta remain healthy.
- [ ] Only then mark the backend cutover complete. Maintain a separate Windows acceptance gate for the Companion local-only installer; existing clients may still attempt to transmit Guildbook fields until updated.

**Ordering:** The upstream tests support `0018 → 0016 → 0017` as well as `0016 → 0017 → 0018`. For future migrations, apply 0018 last when possible and re-check the guard after every migration. In any order, the durable kill-switch must never be silently reopened by later `GRANT` statements.

**Safety boundary:** This PR is preparation; merging it to GitHub `release` does not itself apply a Supabase schema migration. The live private database remains unchanged until all gates pass and a tracked migration is executed. Do not confuse a Vercel production deployment with Supabase migration application.
