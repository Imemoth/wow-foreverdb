# Account-Scoped Guildbook & Independent Companion Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split public collector synchronization from account-scoped Guildbook storage while preserving the #81 → #82 → #83 stack and preventing cross-account Guildbook leakage.

**Architecture:** Prompt 0 defines the shared export, RPC, freshness, and transition contract. Backend, addon, and Companion changes are developed in separate worktrees with disjoint ownership, then integrated on a lead branch based on PR #83.

**Tech Stack:** PostgreSQL/Supabase SQL and real GoTrue/PostgREST tests; WoW Lua SavedVariables/export; C#/.NET WPF; existing GitHub Actions workflows.

**Spec:** `docs/account-v1/account-scoped-guildbook-sync-contract.md` and the coordinated project prompts in the task request.

## Global Constraints

- Preserve PR #81, PR #82, and PR #83; do not merge, force-push, or rewrite them.
- Preserve stable installation IDs, public observations, historical Guildbook rows, registered devices, and revocable credentials.
- No live Supabase migration, production configuration, deployment, installer publication, or new authentication framework.
- Public AutoSync remains user-controlled and works anonymously and after account transitions.
- Private Guildbook is visible only for the active registered account and requires a genuinely fresh addon capture for new attribution.

## Review Focus

- A stale local Guildbook after A → B must never be sent to B: backend replay test and Companion routing test.
- A public snapshot containing Guildbook fields must not create private rows: backend ingest test and public-payload test.
- Sign-out or switch during an in-flight read must not repaint A's data: Companion generation/cancellation test.
- Export/reload without a new observation must not mint a new capture: addon regression test.
- Old schema-9 exports and historical rows must remain readable: parser/migration preservation tests.

### Task A: Backend/API

Agent A owns `database/migrations/**` and `database/tests/**`. Add the minimal account Guildbook tables/ledger, verified RPCs, public-ingest separation, compatibility/backfill, and SQL/GoTrue/PostgREST coverage. Commit independently.

### Task B: Addon

Agent B owns `addon/**` and focused Lua fixtures/tests. Add genuine-capture metadata and backward-compatible export behavior; keep Guildbook attribution out of the addon. Commit independently.

### Task C: Companion

Agent C owns `companion/**` and `tests/companion-*`. Route public and private payloads independently, manage account-generation cache invalidation, load active-account Guildbook, and cover acceptance scenarios. Commit independently.

### Task D: Lead integration

Cherry-pick or merge the three new branches into the lead branch in API → addon/export → Companion order, resolving only contract mismatches. Run focused tests, existing CI-equivalent checks, one scoped isolation review, and a normal Windows Release build where available. Produce an owner checklist for anonymous public sync, A, sign-out, B, fresh B capture, and return to anonymous mode.
