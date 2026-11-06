# Quest Kill Tracker V1.1 live acceptance

This dependent draft PR targets `feat/quest-tracker-v1-local-capture`. Its addon is 0.7.0-alpha; schema 9 and Guildbook local-only policy stay unchanged. Questgiver and turn-in remain separate `accept` and `turnIn` observations. Mob evidence is in `mobObservations` on the character's local quest entry. It is never exported as a new schema-9 record.

1. Install this PR commit with `update-addon.cmd -Ref <full SHA> -AddOnsPath "<Forever>\Interface\AddOns"`; confirm 0.7.0-alpha, `/fdb quest status`, and active #364.
2. Target Mindless Zombie (NPC 1501) without looting. `/fdb quest mobs 364` must show objective 1, NPC 1501, tooltip count and player observation location. Repeat the same target: count stays one. Target Wretched Zombie (1502): it must appear under its distinct objective.
3. Kill a previously matched unit. Death count may increase once, but it must not claim that this death earned quest credit. After objective progress moves (e.g. 0/8 to 1/8), `objective progress ... source=unattributed` increases. A pet/group kill or delayed progress must not be assigned to a particular NPC.
4. Target an unrelated mob and abandon #364. Neither action may create a new quest-mob relationship. Try same-title/duplicate objective quests: ambiguous tooltip evidence must be ignored.
5. Logout and inspect `ForeverDB_Saved.questJournal[<player GUID>].entries["364"].mobObservations`. Each entry has `questId`, `objectiveIndex`, `npcId`, name, tooltip count, death count, evidence type, client locale/build, timestamp and quantized player location. `progressChanges` is a separate objective-index table. Confirm `ForeverDB_Export` still starts `H|9` and contains no journal/mob rows.

Live client outcome: PENDING. Mock smoke tests do not establish compatibility with the live tooltip, combat-log event timing or GUID format.
