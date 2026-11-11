# Quest Tracker V1 implementation plan

Goal: complete and harden the existing local quest collector against the supplied implementation specification.

Architecture: reuse the existing feature branch and draft PR #168 against release. Keep per-character journal data local; extend the existing loot evidence path without new export records.

Tech stack: WoW Lua, existing schema-9 exporter, Lua smoke tests and GitHub Actions.

Spec: user-provided “AzerDex / ForeverDB — Quest Tracker V1 Implementation”; local acceptance contract in v1-acceptance.md.

## Constraints and decisions
- Addon 0.6.0-alpha; schema 9 and Companion 0.9.0-alpha unchanged.
- No production database, deployment, merge, or public release.
- No questgiver inference from target, text-based item matching, removal-as-completion, or reward-choice guessing.
- Existing isolated cloud checkout on requested feature branch is used in place.
- Local-only capture is selected over an export extension because public publisher/read DTOs do not support canonical quests.
- User explicitly requests continuous implementation without design/plan approval stops.

## Review focus
Stale dialog attribution; duplicate completion wiping provenance; old-client index versus quest ID; objective updates after reload; privacy of export data.

## Tasks
1. Add regression smoke cases for metadata, legacy APIs, missing NPCs, repeat acceptance, duplicate completion, unavailable events and commands. Run RED, repair the collector, run the full Lua suite, commit.
2. Test existing loot collection through real database/export and tooltips, preserving quest IDs and observed rates; cover direct evidence, ordinary loot and duplicate windows. Run RED, repair metadata presentation, run the full suite and Guildbook policy checks, commit.
3. Update live-client acceptance, pipeline trace/follow-up contract and version documentation. Run Lua 5.1/5.4 checks, review the branch, push feature commits, update draft #168 and monitor CI.

## Execution evidence
- Repository contained no AGENTS.md. release HEAD cd5d352; existing feature HEAD 5964136 includes QuestTracker.lua (the earlier write succeeded).
- Initial existing quest suite fails its missing-API case: Lua `condition and nil or function` restores the function instead of removing it. Correct the harness before using it as API absence evidence.

- Tasks 1–2 complete: lifecycle/API and tooltip regressions tested RED→GREEN; real Database/Exporter path proves schema-9 journal exclusion and installation preservation.
- Independent read-only review found two Important reload issues (unverified persisted objective IDs and initially empty log suppressing discovery). Both reproduced as failing tests and fixed; journal links now need current-session objective evidence, and coalesced quest updates retry log reconciliation. No minor findings.
- Review declined live API/event/reward/Companion behavior: retained as manual acceptance gates rather than simulated compatibility claims.
- Task 3: pipeline/follow-up contract and exact live commands documented; Lua 5.1 and 5.4 suites pass (168 checks per runtime), Guildbook policy suite 6/6 and migration-tree guard pass. GitHub CI pending push.

- Concurrent remote commits through 75d8899 were merged without overwriting them; offer previews and independent addon-version guard retained. Integration regression also protects confirmed XP/money from duplicate reward previews.

- Final evidence-boundary checks: reward links never invent missing quantities; a new dialog without an ID invalidates older pending giver evidence. Both regressions reproduced RED→GREEN.
