# Quest Tracker V1 — local capture and launch-day acceptance

Branch: `feat/quest-tracker-v1-local-capture`. Addon: `0.6.0-alpha`. Export: **schema 9 unchanged**.

## Scope

- `QUEST_DETAIL` + `QUEST_ACCEPTED`: quest ID, title, level, actual description (`GetQuestText`, up to 8000 bytes), objective text when available, timestamp, the real `npc` unit identifier/name, and **player's quantized approximate map position** while accepting (not an asserted precise NPC position). No inference from an unrelated target.
- `QUEST_LOG_UPDATE`: text and verified item `objectID` in currently active quest objectives (`C_QuestLog.GetQuestObjectives` if available), including numeric progress counters. Legacy `GetQuestLogLeaderBoard` captures text/type/completion without inferring item IDs. Updates coalesce over 0.5s, or throttle to 1s without timers. Login/world entry observes already-active quests without inventing acceptance timestamps or givers.
- `QUEST_COMPLETE` + `QUEST_TURNED_IN`: quest turn-in NPC/location, **offered** guaranteed and optional-choice items, offered XP/money, and **actual awarded** XP/money when supplied by the completion event. The chosen reward item **cannot be inferred** from this preview; it remains unknown.
- `QUEST_REMOVED`: record removal as **removed** with `removedAt`, without asserting abandonment or completion. Only `QUEST_TURNED_IN` marks an actual completion.
- `LOOT_READY`: keep existing `GetLootSlotInfo` quest flag and quest ID evidence; additionally tag item drops identified by active item objectives (numeric item ID only). Persist in existing `questDrops` and `questIds` fields of source item records.
- Tooltip: recorded quest drops are prioritized above ordinary loot and visibly marked `[Quest item]` on mobs. This is **observed historical quest loot**, not a promise that the current player needs the item.
- Local per-character `ForeverDB_Saved.questJournal[GUID]`. Up to 500 entries per character; oldest nonactive entries are evicted when the limit is exceeded. Existing active quests are not discarded. The journal is not included in `ForeverDB_Export` or any Companion RPC. Existing quest-item loot aggregates still travel through the unchanged `I` record. Repeat acceptance starts fresh observation fields; duplicate turn-in preserves the first confirmation. Unknown events are caught and reported in status.

## Slash commands

- `/fdb quest` — show the last locally seen quest record.
- `/fdb quest 367` — show a recorded quest by ID: acceptance, turn-in and coordinates, objective texts, offered items, and confirmed rewards.
- `/fdb quest status` — counts for the current character, local-only export status and registered/unavailable events.
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

1. Back up `WTF/Account/.../SavedVariables/ForeverDB.lua`. From the repository run `update-addon.cmd -Ref feat/quest-tracker-v1-local-capture -AddOnsPath "<actual Forever client>\Interface\AddOns"` (or pin the PR commit SHA). The updater must print `0.6.0-alpha`, the selected commit and the Forever destination; inspect the installed `ForeverDB.toc` for `## Version: 0.6.0-alpha`. Confirm the separate `_classic_beta_` AddOns folder and SavedVariables are unchanged. Launch that Forever client, `/reload`, then verify `/fdb quest status` and `/fdb questapi`. A plain `update-addon.cmd` fetches `release` and cannot install the draft Quest Tracker until merge.
2. Accept a new quest from an NPC, then check `/fdb quest <ID>` for quest ID, giver ID/name and approximately correct zone/coordinates.
3. Kill and loot a relevant mob. Verify the item appears as `[Quest item]` at the **top of its mob tooltip**. Inspect `/fdb last` and existing `questDrops/questIds` records. A nonquest item must remain unmarked.
4. Complete a quest with guaranteed rewards, then one with **choice rewards**. Before confirming the reward dialog, inspect offered guaranteed/choice lists with `/fdb quest <id>`; QUEST_COMPLETE persists an offer preview but must not mark completion or grant items. After turn-in check NPC/zone/coords and event-reported awarded XP/money. Never claim the actual chosen item from a menu alone.
5. Abandon a different quest. It must be `removed`, never `completed`; after turn-in the objective link must stop classifying unflagged drops as currently required.
6. `/reload` and character swap: records persist for the correct character without overwriting another's history.
7. Re-run `/fdb export`; in an isolated staging/test installation only, exercise Companion manual Sync Now with a **nonempty** loot payload; verify unchanged `H|9`, `I` rows, no new `Q` or `R` export records, no questJournal in upload, and no Guildbook cloud rows.
8. Record missing Forever-specific APIs, reward timing and whether the NPC `npc` unit is present at QUEST_DETAIL / QUEST_COMPLETE. Treat unknown as unknown, and raise a narrow follow-up PR if the client differs.

Status: code proposed for review. **Actual WoW: Forever in-game acceptance still pending.**

## Exact capability checks and persisted output

Run these with the addon loaded, then save the output alongside the Forever build number:

```text
/fdb questapi
/fdb quest status
/run print("quest dialog APIs", type(GetQuestID), type(GetQuestText), type(GetTitleText), type(GetObjectiveText))
/run print("reward APIs", type(GetNumQuestRewards), type(GetNumQuestChoices), type(GetQuestItemInfo), type(GetQuestItemLink), type(GetRewardXP), type(GetRewardMoney))
/run print("legacy objectives", type(GetQuestLogTitle), type(GetQuestLogIndexByID), type(GetNumQuestLeaderBoards), type(GetQuestLogLeaderBoard))
/run print("modern objectives", C_QuestLog and type(C_QuestLog.GetQuestObjectives))
```

Expected: each available function prints `function`; unavailable APIs print `nil` and their data must stay absent. `quest status` must show `export=OFF`; unsupported quest events print `UNAVAILABLE`. If `QUEST_TURNED_IN` is unavailable, completion must remain unconfirmed; a removal is not a substitute.

While a quest dialog is open:

```text
/run print("dialog", GetQuestID and GetQuestID(), UnitGUID("npc"), UnitName("npc"))
```

Expected: the ID matches the actual quest; an NPC GUID contains the giver ID. If npc is nil, accept/turn-in snapshots may contain the observed player position but no inferred giver. For auto turn-ins without QUEST_COMPLETE, no `turnIn` position/giver is recorded. Gameobject identity is captured only when `npc` actually supplies a GameObject GUID; otherwise it remains unknown. Quest-chain prerequisites are not inferred.

After acceptance, `/fdb quest <id>` must show the actual title, description and objective text; two accepted quests must stay distinct. Close/cancel a dialog and accept another quest: no previous giver may leak. An unrelated combat target must never appear as a giver. Missing quest IDs must create no canonical record.

After `/reload` or clean logout, inspect the account-level `WTF/Account/<account>/SavedVariables/ForeverDB.lua` with the game closed (do not edit while running). For the current character, print the key with `/run print(UnitGUID("player"))` beforehand. Expected shape (illustrative values; absent capabilities omit fields):

```lua
ForeverDB_Saved = {
  schemaVersion = 9,
  installationId = "<unchanged existing ID>",
  questJournal = {
    ["Player-..."] = {
      lastQuestId = 367,
      entries = {
        ["367"] = {
          questId = 367, title = "A New Plague", level = 7,
          description = "<actual GetQuestText text>",
          objectiveText = "<actual GetObjectiveText text>",
          status = "completed", acceptedAt = 1234567890, completedAt = 1234567990,
          accept = {sourceType="creature", sourceId=99, name="<giver>",
            location={mapId=85, zoneName="Tirisfal Glades", subZoneName="Brill", x=31.5, y=60}},
          turnIn = {sourceType="creature", sourceId=501, name="<receiver>", location={mapId=85}},
          objectives = {{text="<client objective>", kind="item", finished=false, numFulfilled=2, numRequired=5}},
          requiredItemIds = {["123"]=true},
          rewards = {guaranteed={{itemId=901, name="<item>", quantity=1}},
            choices={{itemId=902, name="<choice>", quantity=1}},
            offeredXP=1000, offeredMoney=150, grantedXP=1700, grantedMoney=275},
        },
      },
    },
  },
}
```

`requiredItemIds` is historical after completion and only used when status is active. No `selectedItemId` or `grantedItems` is claimed: no validated client selection/grant hook is established in this version. Offered guaranteed items are also not proof of an actual item grant. The event's XP/money parameters are only considered confirmed after live event-signature validation. Pre-existing log quests get `logObservedAt` instead of invented `acceptedAt`. A removed quest gets `status="removed"`, `removedAt`, no `completedAt`.

In `sources["creature:<mobID>:<level>"].buckets.mob.items["<itemID>"]`, expect `drops` once per observed loot window, summed `quantity`, `questDrops`, and `questIds={["<questID>"]=true}` only where known. Flag-only quest items have an empty questIds table; ordinary lookalike names do not get quest metadata. The source bucket location retains the existing quantized coordinates. Inspect `ForeverDB_Export`: header `H|9`, existing `I` quest counts/IDs, no journal, character GUID, description, `Q` or `R` lines. Preserve an older SavedVariables backup, upgrade, then confirm installation ID, old sources and other collectors still work.

Record each manual case as PASS/FAIL/PENDING with build, event/API output, quest/item IDs, saved-data evidence and timestamp. All live cases remain PENDING for this draft.
