# ForeverDB sync behavior

## Supported sync path

ForeverDB Companion **0.7.0-alpha** owns database synchronization.

The addon itself never performs HTTP. It writes `ForeverDB_Export` into
SavedVariables, and the Companion watches the WoW account folders for updated
`ForeverDB.lua` files.

WoW normally writes SavedVariables to disk on:

- `/reload`
- logout
- client exit

When the exported snapshot changes, the Companion parses it and syncs it to
Supabase.

## Authentication

The Companion uses Supabase anonymous authentication to establish an installation
identity and stores the local session protected by Windows data protection.

Uploads call:

`ingest_foreverdb_snapshot_auth`

with an authenticated bearer token.

The former shared ingest-token RPC has been removed from the current database
migration chain.

## Snapshot safety

Each upload represents the complete current snapshot for one installation.

The server stores the timestamp of the latest accepted snapshot. Older snapshots
are ignored, so an older WTF backup cannot roll central data backwards.

For an accepted snapshot, that installation's previous source, item and location
statistics are replaced by the incoming values. Re-sending the same logical
snapshot therefore does not accumulate duplicate counts.

## Map metadata and pre-warming

Map metadata embedded in schema-8 exports is merged into the Companion's local
map metadata cache before the network ingest completes.

After a successful sync, the Companion opportunistically pre-warms map art for
up to four recently observed/highest-weight zones. Pre-warming is best-effort and
never makes SavedVariables sync fail.

## Legacy scripts

`sync-db.cmd` and `scripts/sync-db.ps1` belong to the retired shared-token
prototype. They still reference the removed legacy ingest RPC and are **not a
supported sync path** for the current database.

They should not be used for current Companion validation and are scheduled for
cleanup before the 0.8 hardening milestone.
