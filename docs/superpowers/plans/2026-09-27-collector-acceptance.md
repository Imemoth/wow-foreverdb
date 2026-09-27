# Collector acceptance preparation implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Herbalism and Disenchant acceptance executable without claiming live evidence.

**Architecture:** Retain collector behavior and schema. Add only debug messages at silent tracker boundaries; exercise the real Lua tracker/database/export pipeline with simulated WoW APIs. Extend the beta plan and link it from the open roadmap gates.

**Tech Stack:** WoW Lua, standalone Lua smoke tests, Markdown.

**Spec:** User request of 2026-09-27; `docs/ROADMAP.md` collector closure and engineering rule 6.

## Global constraints

- Live WoW, SavedVariables disk flushing, Companion ingest and search remain PENDING without client evidence.
- No speculative event-order fixes, schema changes, version bumps or unrelated collector changes.
- Baseline: main `7aa400582be4ad32287b4a1274ddb0db50724750`.

## Review focus

- Loot event ordering and cursor/container API behavior require client evidence.
- Wrong bucket or source ID must fail acceptance even when a counter increments.
- Reopening partially looted windows can duplicate observations; test explicitly.
- Cursor cancellation / expired state must not contaminate unrelated loot.
- Export rebuild is in memory; only client save/reload proves disk persistence.

## Task 1: Tracker diagnostics and offline contract check

Files: `addon/ForeverDB/{GatheringTracker,DisenchantTracker}.lua`, `tests/collector_smoke.lua`.
Consumes: WoW event handlers and existing Database/Exporter/LootTracker APIs.
Produces: bounded debug breadcrumbs; executable simulated collector checks.

- [x] Exercise herbalism and disenchant source/bucket/count/export contracts, event deduplication, failed/expired casts and modern/legacy container hooks using real addon modules.
- [x] Add debug-only breadcrumbs for hook setup, cursor detection, missing/expired targets, arm/consume, failed casts and gathering expiry. Preserve state transitions.
- [x] Run `texlua tests/collector_smoke.lua` (or `lua tests/collector_smoke.lua`); expected: all simulated checks pass. This is not live E2E evidence.

## Task 2: Acceptance runbook and roadmap

Files: `docs/BETA_TEST_PLAN.md`, `docs/ROADMAP.md`.
Consumes: Task 1 diagnostics and existing schema 9 contract.
Produces: initial conditions, exact actions and deltas, last observation, export/SavedVariables checks, downstream gate, failure diagnosis and PENDING evidence matrix.

- [x] Add Herbalism and Disenchant success, repeated/multi-item, cancellation/timeout/cross-contamination and persistence cases.
- [x] Document export record fields and SavedVariables paths; distinguish observed windows from actual item pickup.
- [x] Link the runbook from roadmap; keep both live E2E checkboxes open.
- [x] Review every expectation against code, run smoke tests and `git diff --check`; expected: no errors, no invented live PASS.
- [x] Commit and obtain whole-branch review; hand off reviewed changes as a GitHub PR.

## Verification record — 2026-09-27

- `texlua tests/collector_smoke.lua`: 8/8 simulated checks passed before and after diagnostics changes, and after rebase.
- Lua syntax compilation: all 13 addon Lua modules plus the test file passed.
- `git diff --check`: clean.
- Independent read-only whole-branch review: no actionable findings; repo preparation ready for review/merge.
- Remote main advanced during preparation; rebased onto `d543c60f4f75557492a56010126556b357dbed21`. Upstream Guildbook acceptance updates were preserved; collector contracts were unchanged.
- Ruling: retain existing collector state transitions and add diagnostics only. Event-order, cursor semantics, partial-window reopening and cross-contamination remain live acceptance gates; guessing fixes would risk incorrect sample attribution.
- WoW runtime, disk persistence and downstream E2E: **PENDING**, no client evidence collected.
