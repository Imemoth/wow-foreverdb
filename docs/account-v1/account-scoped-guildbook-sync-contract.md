# Account-Scoped Guildbook & Independent Companion Sync Contract

Status: Prompt 0 contract for the #81 → #82 → #83 integration. New work is based on PR #83 (`4d46180044b9949cc20101822c607f510885caad`); those PR branches remain unchanged.

## Identities and payloads

- `installationId` is the stable technical collector ID from SavedVariables. It is never changed, transferred, or treated as the active human account.
- Public observations are the `sources`, `maps`, and related public observation fields from the existing schema-9 snapshot. They are uploaded through the collector path: the existing anonymous session for anonymous mode, or the existing registered device credential (`fdb_device_ingest`) when enrolled. The interactive registered-account session is not required for this path.
- Private Guildbook is uploaded separately from public observations. Its account attribution comes only from the verified registered Supabase Auth identity on the account Guildbook RPC; a device/installation owner is not an account attribution signal.
- The Companion must construct the public payload without `guilds`, and must send Guildbook only through the account Guildbook RPC. A public ingest path must ignore/reject private Guildbook fields rather than persist them.

## Fresh capture provenance

- Schema 9 remains readable. The addon may append optional Guildbook capture metadata to the export header; old headers with no metadata remain valid.
- A genuine roster/profession observation creates a new opaque `guildbookCaptureId`, `guildbookCapturedAt` (server/Unix seconds), and source-character identity. Re-export, `/reload`, logout, and unchanged snapshots do not create a new capture.
- The Companion passes all three values plus the Guildbook records to the account ingest RPC. `guildbookCapturedAt` must be at or after the active account session boundary. The backend accepts a capture only once for an installation and capture ID, rejects a replay or an older capture timestamp, and never accepts a stale local snapshot merely because a different account signed in.

## Account transitions

- Sign-out/switch increments the Companion account generation, cancels/invalidate in-flight account Guildbook work, clears all visible/private Guildbook caches, and leaves SavedVariables, installation ID, public observations, device credentials, and public AutoSync state intact.
- On account A → B, B can read B's server-side Guildbook immediately. A's local snapshot is not sent to B unless the addon produces a new capture after the switch; B's new capture is attributed to B by the verified Auth RPC.
- Anonymous mode hides account Guildbook and leaves public search and public AutoSync available. Reload must not restore a prior account's private cache.

## PostgreSQL/API surface

- Preserve existing public search, observation rows, registered devices, and historical installation Guildbook rows. Existing RPC signatures remain callable where compatibility requires it.
- Add the smallest account-scoped Guildbook storage/ledger needed for `fdb_account_guildbook_ingest(...)`, account-owned Guildbook reads, and capture replay/freshness checks. Reads and writes require the normal live registered-session guard; anonymous callers receive no private data.
- Preserve the existing collector/device authorization, per-installation lock, quotas, and revocation checks. Do not add a JWT service, HMAC layer, or live migration/deployment step.
- Migration compatibility must retain old rows and provide a deterministic transition for registered-account Guildbook already stored by installation ownership. Installation ownership is not rewritten by Guildbook migration.

## Ownership and integration boundaries

- Agent A owns `database/migrations/**`, `database/tests/**`, and backend contract tests.
- Agent B owns `addon/**`, Lua fixtures/tests, and addon export metadata. It must not decide account ownership.
- Agent C owns `companion/**`, `tests/companion-*`, and Companion integration notes/build scripts. It consumes this contract and Agent A's final RPC names without editing database/addon modules.
- Lead owns this contract, integration branch, cross-module adapters, conflict resolution, final tests/CI, scoped isolation review, Windows Release build, and the acceptance report.

## Branch strategy

Create three new branches/worktrees from #83, one per owner. Do not merge, force-push, or rewrite #81, #82, or #83. Integrate A's database/API commit first, then B and C; resolve only contract/export mismatches in the lead branch.
