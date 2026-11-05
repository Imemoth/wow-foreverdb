# Quest Tracker V1 — local capture and launch-day acceptance

Branch: `feat/quest-tracker-v1-local-capture`. Addon: `0.6.0-alpha`. Export: **schema 9 unchanged**.

## Scope

- `QUEST_DETAIL` + `QUEST_ACCEPTED`: quest ID, title, objective/description text when available, timestamp, the real `npc` unit identifier/name, and **player's quantized approximate map position** while accepting (not an asserted precise NPC position). No inference from an unrelated target.
- `QUEST_LOG_UPDATE`: text and verified item `objectID` in currently active quest objectives (`C_QuestLog.GetQuestObjectives` if available).
- `QUEST_COMPLETE` + `QUEST_TURNED_IN`: quest turn-in NPC/location, **offered** guaranteed and optional-choice items, offered XP/money, and **actual awarded** XP/money when supplied by the completion event. The chosen reward item **cannot be inferred** from this preview; it remains unknown.
- `QUEST_REMOVED`: record removal/abandonment as **removed**, not completed. Only `QUEST_TURNED_IN` marks an actual completion.
- `LOOT_READY`: keep existing `GetLootSlotInfo` quest flag and quest ID evidence; additionally tag item drops identified by active item objectives (numeric item ID only). Persist in existing `questDrops` and `questIds` fields of source item records.
- Tooltip: recorded quest drops are prioritized above ordinary loot and visibly marked `[Quest item]` on mobs. This is **observed historical quest loot**, not a promise that the current player needs the item.
- Local per-character `ForeverDB_Saved.questJournal[GUID]`. Up to 500 entries per character; oldest nonactive entries are evicted when the limit is exceeded. Existing active quests are not discarded. Nothing is sent through `ForeverDB_Export` or any Companion RPC.

## Slash commands

- `/fdb quest` — show the last locally seen quest record.
- `/fdb quest 367` — show a recorded quest by ID: acceptance, turn-in and coordinates, objective texts, offered items, and confirmed rewards.
- `/fdb questapi` — existing read-only client API probe; **must still work**.
- `/fdb last` — existing last-loot observation, with quest-item count.

## No-go boundaries

- Do not add new schema-9 export line types or modify the Companion/SQL parsers, public API, Supabase objects or collection access policies in this PR.
- Do not send quest journals, guild roster/professions, or local Guildbook data to the server. The Guildbook local-only guard stays in place.
- APIs missing or not returning IDs must produce unknown/nil fields, not extrapolated NPC, quest, map, item or reward data.
- In the first iteration no on-screen quest route HUD, account sync or public AzerDex Quest Database. Those need a separate schema-10/Companion/privacy design.

## Automated smoke gate

`lua5.4 tests/quest_tracker_smoke.lua` (also part of collector-smoke CI):

- Quest acceptance ID/title/NPC/map/objectives, duplicate event idempotence
- Correct turn-in NPC/map, fixed vs choice offers, actual XP/money separation
- Removal is not completion; character isolation; missing quest APIs fail soft
- `GetLootSlotInfo` false + verified active item objective still yields quest item
- Historical quest item appears first on mob tooltip even with a lower drop rate
- Existing `tests/collector_smoke.lua`, `tests/quest_api_smoke.lua`, `tests/session_tracker_smoke.lua` and `tests/session_ui_smoke.lua` must remain green

**Mock success is not live-client evidence.** Only mark acceptance complete after actual WoW: Forever build 16001 testing.

## Required in-game acceptance (human operator)

1. Back up `WTF/Account/.../SavedVariables/ForeverDB.lua`; verify addon `0.6.0-alpha` and `/fdb questapi`.
2. Accept a new quest from an NPC, then check `/fdb quest <ID>` for quest ID, giver ID/name and approximately correct zone/coordinates.
3. Kill and loot a relevant mob. Verify the item appears as `[Quest item]` at the **top of its mob tooltip**. Inspect `/fdb last` and existing `questDrops/questIds` records. A nonquest item must remain unmarked.
4. Complete a quest with guaranteed rewards, then one with **choice rewards**. Before accepting the turn-in reward, verify offer preview is available. After turn-in check NPC/zone/coords and event-reported awarded XP/money. Never claim the actual chosen item from a menu alone.
5. Abandon a different quest. It must be `removed`, never `completed`; after turn-in the objective link must stop classifying unflagged drops as currently required.
6. `/reload` and character swap: records persist for the correct character without overwriting another's history.
7. Re-run `/fdb export` and Companion manual Sync Now with a **nonempty** loot payload; verify unchanged `H|9`, `I` rows, no new `Q` or `R` export records, no questJournal in upload, and no Guildbook cloud rows.
8. Record missing Forever-specific APIs, reward timing and whether the NPC `npc` unit is present at QUEST_DETAIL / QUEST_COMPLETE. Treat unknown as unknown, and raise a narrow follow-up PR if the client differs.

Status: code proposed for review. **Actual WoW: Forever in-game acceptance still pending.**
