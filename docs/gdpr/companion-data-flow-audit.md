# Addon and Companion data-flow audit (basis of the notice's separate section)

Source: the RC baseline `4ad0f6f`. Facts below were checked in code; "inference" is marked. The notice section *Addon and Companion* in `PrivacyContent.tsx` is derived from this and pinned by `web/tests/unit/companion-disclosure.test.ts`.

## Distinctions requested

| Area | Reality in this RC |
| --- | --- |
| **Public AzerDex website** | Reads only the public aggregate read model. No installation/account/guild data reaches it. |
| **Supabase Auth accounts** | Email + password, optional, free; sessions as sealed cookies; welcome queue keeps only SHA-256 of the email. |
| **Linked Companion installations** | `private.account_installations` (installation id ↔ account uid ↔ previous anonymous owner), audit rows, device registry (label = Windows computer name when connected from the Companion), enrollment tickets. |
| **Private ForeverDB observation uploads** | Companion uploads the **whole** addon export (`p_snapshot`): installation id, versions, source/item/location statistics **and the Guildbook**. Stored in `public.installations*` tables, private (RLS, no API privilege), replaced on each sync. |
| **Public, sanitised aggregate data** | Projected by the publisher (name allow-list, 1.0 coordinate grid, cells ≥ 2 observations, rates hidden < 10). No installation/account/guild column exists in the public schema. Weakness: suppression is by observation count, not distinct installations, so a single-contributor figure can be published (`dominated` flag); docs/web/data-classification.md already admits it. |
| **Guildbook "local-only"** | **True only for the hosted website** (it neither serves nor links it: `account/guildbook/page.tsx`, pinned by `account-web-static.test.ts`). **Not true for the Companion in this RC**: `SyncService.cs` serialises the snapshot including `Guilds`, and `0005_guildbook_v1.sql` persists it. The "Companion-local only" change (PR #112) is merged only into `feature/account-independent-collector-credentials`. This PR changes no Guildbook behaviour. |
| **Truly local-only data** | The addon **session tracker** (character name/realm, gold/XP, history) is never exported (`Exporter.lua` reads only maps, guilds, sources). |

## Addon (local)
Installation id (random 128-bit hash seeded from time, `UnitGUID("player")` and a table address), loot/source/location statistics (positions quantised to 0.5 % of the map), Guildbook (guild name, realm; member GUID, name, class, level, rank, online, zone, last-online hours, professions; the player's own professions; refresh every 30 min; officer notes not collected), session tracker (local-only). No network calls or addon-channel messages found.

## Companion (Windows, v0.9.0-alpha)
- Reads `WTF/**/ForeverDB.lua`; parses `ForeverDB_Export`.
- Uploads to one hard-coded Supabase project over HTTPS (publishable key only): `ingest_foreverdb_snapshot_auth`, `fdb_device_*`, `fdb_account_*`, GoTrue (anonymous sign-up, password sign-in, logout), searches/stats, **map diagnostics** (`rest/v1/map_asset_diagnostics`: versions, map/build fingerprint, WoW folder name, `user_id`).
- Other hosts: `wago.tools` (public build number; user's IP visible) and, inference, Blizzard's CDN via CascLib for local map extraction.
- Local storage under `%LOCALAPPDATA%\ForeverDB\`: settings, DPAPI-protected session/credential blobs (tokens, registered email, installation id marker), map caches; HKCU Run key if "launch with Windows". No log files, no telemetry/analytics/crash reporter/update check found (grep of `companion/`), no cookies.
- Production gates in code: `ProductionAccountAuthApproved = true`, `ZeroTouchEnrollmentApproved = false`, `DeviceAutoSyncApproved = false` (a registered device uploads only on "Sync now"); anonymous installations still auto-sync by default.

## Server-side private tables (columns that identify)
See [retention-schedule.md](retention-schedule.md) for retention. Identifying columns: `installations.owner_user_id`; Guildbook tables (`guild_name`, `realm_name`, `member_guid`, `member_name`, class, level, rank, zone, professions); `installation_claims` (`initiator_uid`, `consumed_by`); `account_installations` (`account_uid`, `previous_owner_uid`); `account_audit` / `device_audit` (`account_uid`, `actor_uid`, `installation_id`); `enrollment_tickets.label`, `devices.label` (computer name), `devices.auth_uid`; `foreverdb_api_budgets.bucket` (contains uids); welcome tables (`user_id`, `email_sha256`); `map_asset_diagnostics.user_id`. No IP or user-agent columns in any migration (provider logs hold those).
There is **no deletion RPC**; foreign keys do not link private tables to `auth.users` (see [dsar-runbook.md](dsar-runbook.md) section 6). Inference: which of migrations 0010-0015 are applied to production cannot be verified from the repository.

## Public/product statements that contradict the code (owner decision; not edited in this PR)
1. `web/src/app/addon-companion/page.tsx:34` — "Sends aggregated observation counters … never raw private data" (omits the Guildbook upload, installation id, device label).
2. `web/src/app/about/data/page.tsx:30` — "uploads aggregated counters for your installation" (same omission).
3. `web/content/guides/getting-started-with-foreverdb.md:36` — "uploads aggregated counters after you log out or reload" (omits Guildbook; registered devices upload only on "Sync now").
4. `web/content/news/companion-guildbook-polish.md:3,20` — "private … never published" (true) but silent that it is uploaded and tied to an owner account.
5. `docs/account-v1/README.md:73-78` — stale `ProductionAccountAuthApproved = false`; `docs/SYNC.md:38-40` omits the guild tables; `docs/GUILDBOOK-API.md` / `CHANGELOG.md` "no guild data is persisted or uploaded" describe only the 0.4.0 probes (historical).
6. The email templates (`docs/azerdex-auth-email/templates/*`) and the welcome email contain no privacy link.
The new notice is the accurate description; these should be reconciled once the Guildbook decision (README blocker 1) is made.
