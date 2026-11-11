# Quest V1 pipeline boundary and follow-up contract

## Inspected current pipeline

1. Addon `QuestTracker.lua` stores `ForeverDB_Saved.questJournal[characterGUID].entries[questID]`. It is a bounded per-character observation journal, not a global canonical truth table. Older SavedVariables need no journal migration: tables are created lazily; installation IDs and existing sources stay intact. Old entries remain readable; new fields are optional.
2. `LootTracker.lua` feeds the existing `Database.lua:RecordObservation`: source type/ID/level, loot kind, quantity, drop count and locations. Direct quest flag, direct positive quest ID, or active objective numeric item ID establishes quest evidence. No text matching. This remains an observation of the loot window, not a claim of an official drop probability or proof an item reached the bag.
3. `Exporter.lua:BuildExportSnapshot` explicitly writes existing schema-9 records. `I` fields include questDrops and CSV questIds. It does not serialize questJournal. There are no new record types or modified column positions.
4. Companion `Services/ForeverDbExportParser.cs:ParseSavedVariables` reads only `ForeverDB_Export` from the Lua file and `ParseExport` maps I-row quest metadata to `ForeverDbItem`. `Models/PublicObservationSnapshot.cs` explicitly projects sources/maps; `ForeverDB.Companion.Account/PublicSnapshotGuard.cs` rejects unknown payload fields. No journal model or upload exists.
5. Existing authenticated/device ingestion stores source-item quest counts/IDs (e.g. `database/migrations/0003_companion_auth.sql` and its later replacement functions). The local-only restrictions in `0018_disable_guildbook_cloud_sync.sql` remain unchanged; `scripts/check-guildbook-local-only-policy.mjs` guards migration regressions. No RPC, grant, policy, or production database is changed here.
6. The private export/publisher contract (`publisher/src/core/contract.ts`, mirrored under `supabase/functions/publish-observations/core`) reads quest_drops for contract completeness but does not publish it. `web/src/lib/data/types.ts` and `postgres-adapter.ts` read public source/item DTOs, not canonical quests. V1 therefore does not make quest pages or markers publicly available on AzerDex.

## Decision

Keep export schema 9 and Companion 0.9.0-alpha. The addon capability is 0.6.0-alpha. A separate end-to-end quest contract is needed; adding Q/R lines now would give an incomplete ingestion/read-model path. Local per-character capture retains provenance for later evaluation, while observed quest loot keeps the already supported transport. No server migrations or website changes belong in V1.

## Follow-up PR A: versioned anonymous quest observations

- Agree an explicit schema extension/version and parser compatibility policy before changing exporter output. Old Companion must reject unsupported versions clearly or skip an explicitly optional extension without silently dropping required data. Test both directions using saved fixtures.
- Separate canonical candidate metadata (quest ID, locale, client build, title/description/level), objective candidates, offer candidates, and giver/receiver observation rows (source type/ID, map, quantized position, observed time, evidence API/event). Observed player position must never become asserted precise NPC spawn position.
- Model selected reward versus granted reward separately with explicit evidence and unknown values. Validate a live-client selection/grant hook before adding those claims.
- Export no character GUID/name, realm, account quest log, completion history or per-character progress. Do not export the raw journal. Define provenance IDs, retention, minimum aggregation thresholds and deduplication independently of a player's identity.
- Group reports by client build and locale. Retain disagreements and evidence counts; never overwrite canonical truth with the latest single report. Cross-character agreement is not independent evidence unless provenance allows it to be established safely.
- Parser/model, payload allowlist, server validator, idempotent ingest and storage migrations must ship with fixtures for missing/unknown fields, old schema 9, conflicts, replays, malformed IDs and character-data rejection. Guildbook restrictions remain invariant.

## Follow-up PR B: public quest read model and AzerDex

- Define publication thresholds and provenance/conflict summaries from PR A observations, with explicit unknown/unverified data states.
- Publish candidate quest metadata, objectives, offered rewards, observed giver/turn-in positions and source-item-quest relationships through narrow public read DTOs and allowlisted publisher fields.
- Add public quest pages, maps and source/item links only after contract, publication and privacy tests pass. Do not infer prerequisites or quest chains from session order; add only client-proven relationships.
- Test the whole fixture path addon export → Companion parser → payload → ingestion → publication → read model → page. Deployment/migrations/public release each require owner approval outside this draft.
