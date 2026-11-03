# Addon and Companion data-flow audit (basis of the notice's separate section)

Updated for the Guildbook local-only integration (branch `fix/guildbook-local-only-rc`, stacked on the GDPR branch). Facts below were checked in code;
"inference" is marked. The notice section *Addon and Companion* in `web/src/components/PrivacyContent.tsx` is derived from this and pinned by
`web/tests/unit/companion-disclosure.test.ts` and `tests/companion-account/PublicPayloadBoundaryTests.cs`.

**Owner policy (final):** Guildbook data stays exclusively on the user's computer. No upload, download, backup, remote synchronization or cloud RPC access.

## Before / after

| | RC `4ad0f6f` / GDPR branch before this change | After this change |
| --- | --- | --- |
| Companion upload body | `p_snapshot = snapshot`: the whole parsed snapshot **including `guilds`** (guild name/realm, member GUID, name, class, level, rank, online, zone, last-online, professions) | `PublicObservationSnapshot` only: `schemaVersion, addonVersion, installationId, updatedAt, sources, maps`. No Guildbook member exists in the type |
| Transport check | none | `PublicSnapshotGuard` (fail-closed structural allowlist, every object at every depth) enforced inside `RpcClient.IngestAsync` and `DeviceRpcClient.IngestAsync` before any request is built. A violation is refused, nothing is sent |
| Server ingest (`ingest_foreverdb_snapshot_auth`, `fdb_device_ingest`) | persists `installation_guilds / _members / _professions` from the payload | with migration 0018 (**prepared, not applied**): the private ingest implementation is fronted by an observation-only projection, so an old client that still sends `guilds` stores nothing |
| Legacy read RPCs `fdb_account_guildbook_guilds/members` (0012) | executable by `authenticated` | with 0018: revoked from every API role |
| Website (`/account/guildbook`, `/account/api/guildbook/*`) | 404 on hosted, RPC code present behind a local-deployment guard | routes are deny-by-default stubs with no RPC call; the RPC is not in the web allowlist |
| Local Guildbook | held in memory from SavedVariables, shown regardless of sign-in | `%LOCALAPPDATA%\ForeverDB\guildbook\<hash(account)>\<hash(installation)>\snapshot.dat`, DPAPI CurrentUser, backup generation, shown only for a server-verified registered account; sign-out clears the view and keeps the files; restore at startup and sign-in uses no network |
| Anonymous installations | Guildbook visible, uploaded | no Guildbook is stored or shown; public observation sync unchanged |
| Historical data uploaded before | present | **still present** until the owner-authorized cleanup (see `docs/guildbook-local-only/historical-guildbook-data.md`) |

## Distinctions requested

| Area | Reality after this change |
| --- | --- |
| **Public AzerDex website** | Reads only the public aggregate read model. No installation/account/guild data reaches it; no way to call a cloud Guildbook RPC. |
| **Supabase Auth accounts** | Email + password, optional, free; sessions as sealed cookies; welcome queue keeps only SHA-256 of the email. |
| **Linked Companion installations** | `private.account_installations` (installation id ↔ account uid ↔ previous anonymous owner), audit rows, device registry (label = Windows computer name when connected from the Companion), enrollment tickets. |
| **Private ForeverDB observation uploads** | Installation id, versions, source/item/location statistics, map metadata. Stored in `public.installations*` statistics tables (private: RLS, no API privilege), replaced on each sync. **No Guildbook.** |
| **Public, sanitised aggregate data** | Projected by the publisher (name allow-list, 1.0 coordinate grid, cells ≥ 2 observations, rates hidden < 10). No installation/account/guild column exists in the public schema. Weakness (unchanged): suppression is by observation count, not distinct installations, so a single-contributor figure can be published (`dominated` flag); docs/web/data-classification.md already admits it. |
| **Guildbook (local-only data)** | Stays on the computer: DPAPI-protected store above, plus the raw export that the addon writes to the WoW SavedVariables file (not encrypted by the Companion; local filesystem access = access). |
| **Truly local-only, never exported** | The addon **session tracker** (character name/realm, gold/XP, history): `Exporter.lua` reads only maps, guilds, sources. |

## Addon (local)
Installation id (random 128-bit hash seeded from time, `UnitGUID("player")` and a table address), loot/source/location statistics (positions quantised to 0.5 % of the map), Guildbook (guild name, realm; member GUID, name, class, level, rank, online, zone, last-online hours, professions; the player's own professions; refresh every 30 min; officer notes not collected), **Guildbook capture provenance** (capture id, capture time, source character) written in the export header, session tracker (local-only). `/fdb guildbook refresh` triggers a capture. No network calls or addon-channel messages found.

## Companion (Windows, v0.9.0-alpha)
- Reads `WTF/**/ForeverDB.lua`; parses `ForeverDB_Export`.
- Uploads (public observations only) to one hard-coded Supabase project over HTTPS (publishable key only): `ingest_foreverdb_snapshot_auth`, `fdb_device_ingest`, linking/enrollment RPCs, GoTrue (anonymous sign-up, password sign-in, logout), searches/stats, **map diagnostics** (`rest/v1/map_asset_diagnostics`: versions, map/build fingerprint, WoW folder name, `user_id`). No Companion code calls a `fdb_account_guildbook_*` RPC (enforced by a source-level test).
- Other hosts: `wago.tools` (public build number; user's IP visible) and, inference, Blizzard's CDN via CascLib for local map extraction.
- Local storage under `%LOCALAPPDATA%\ForeverDB\`: settings, DPAPI-protected session/credential blobs, `guildbook\` (DPAPI), map caches; HKCU Run key if "launch with Windows". No log files, no telemetry/analytics/crash reporter/update check (grep of `companion/`), no cookies.
- Production gates in code (unchanged): `ProductionAccountAuthApproved = true`, `ZeroTouchEnrollmentApproved = false`, `DeviceAutoSyncApproved = false`.

## Server-side private tables (columns that identify)
See [retention-schedule.md](retention-schedule.md). Identifying columns: `installations.owner_user_id`; **Guildbook tables (historical rows only)** (`guild_name`, `realm_name`, `member_guid`, `member_name`, class, level, rank, zone, professions); `installation_claims`; `account_installations`; `account_audit` / `device_audit`; `enrollment_tickets.label`, `devices.label` (computer name), `devices.auth_uid`; `foreverdb_api_budgets.bucket` (contains uids); welcome tables; `map_asset_diagnostics.user_id`. No IP or user-agent columns in any migration.
There is **no deletion RPC**; foreign keys do not link private tables to `auth.users` (see [dsar-runbook.md](dsar-runbook.md) section 6). Inference: which of migrations 0010-0015 are applied to production cannot be verified from the repository.

## Public/product statements reconciled in this change
`addon-companion/page.tsx`, `about/data/page.tsx`, `content/guides/getting-started-with-foreverdb.md`, `content/blog/building-a-safe-public-database.md`, `content/news/companion-guildbook-polish.md` (dated update note: earlier versions uploaded the Guildbook; deletion not yet done), `account/link/page.tsx` ("its Guildbook" no longer moves to an account), and the Companion's anonymous-mode message. Still historical/unchanged: `CHANGELOG.md` and `docs/GUILDBOOK-API.md` 0.4.0-era statements; `docs/account-v1/README.md:73-78` (stale `ProductionAccountAuthApproved`); `docs/SYNC.md:38-40` (guild tables in the sync description). The email templates and the welcome email still carry no privacy link (owner action; templates are published to Resend).

## What has NOT been verified
- Interactive Windows/GUI acceptance and the real WoW Forever release-client capture on the RC Companion build (the 2026-10-26 manual acceptance was recorded on the #112 baseline; synthetic fixtures are not release-client acceptance).
- Migration 0018 has not been applied to any real project; its tests run only in disposable CI databases.
- Whether guild rows exist in production, and how many: the read-only inventory has not been run (see the historical-data document).
