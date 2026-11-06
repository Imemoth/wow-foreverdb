# AzerDex Product & Engineering Roadmap — V1.0

**Created:** 2026-11-06  
**Status:** PROPOSED / owner review (becomes the active prioritization contract only after acceptance)  
**Production branch:** release (not main)  
**Baseline:** release @ 2c8ccd6 (PR #167 merged)  
**Owner:** AzerDex product owner  
**Scope:** the public AzerDex product, News, guides, data publication, operations and cross-surface decisions; implementation of Addon/Companion stays governed by its own safety and live-acceptance gates.

## Purpose and source of truth

Build AzerDex into a trustworthy, fast, useful and regularly visited WoW: Forever reference. Sequence: **reliability → usability → verified core data → content / discoverability → new features**. This is the forward-looking product priority ledger. It does not delete or rewrite older evidence.

- [Earlier website milestone ledger](azerdex-roadmap.md): historical P1–P3 implementation/acceptance record; not the current release prioritization queue.
- [Addon/Companion roadmap](../ROADMAP.md): separate release and data-privacy gates; do not infer live acceptance or public approval from website progress.
- [News V2 G4/G5/G6 audit](g4-g5-g6-execution-log-2026-11-05.md): completed production evidence; [PR #167](https://github.com/Imemoth/wow-foreverdb/pull/167), squash 2c8ccd6.

For conflicting current-state claims, prioritize newly verified live state and owner decisions; distinguish evidence from hypotheses.

## Baseline and immovable boundaries

**Verified release status at the G4/G5/G6 closure:**

| Gate | Status | Evidence / exception |
| --- | --- | --- |
| G2 — monitoring functions | COMPLETE | Production install and read-only health verification |
| G4 — V2 website | COMPLETE | Production acceptance; deployed aliases verified |
| G5 — historical backfill | SKIPPED — ACCEPTED HISTORICAL GAP | Dry-run only: 1 possible insert (US post:30732723), 0 updates, 7 unchanged; no write authorized or performed |
| G6 — cron monitoring | COMPLETE | Job 7 every 15 minutes; successful first run; **no Discord/email delivery yet** |
| PR #167 | MERGED | 2c8ccd6, documentation only |

**Open safeguards and limitations:** the validated four-schema backup is not full Supabase recovery/PITR; an encrypted off-machine copy remains unverified. Discord/email notifications do not exist. Guildbook remains Companion-local; no server-side sync may be reintroduced under this roadmap. The dormant global story grouping in Draft PR #165 is separate; no story linking without explicit approval.

### Existing active owner commitment takes precedence

At 2026-11-06, [Issue #169](https://github.com/Imemoth/wow-foreverdb/issues/169) remains open: Quest Tracker V1 live acceptance provenance, giver/receiver relationships and Quest Kill Tracker observations (Draft PRs [#168](https://github.com/Imemoth/wow-foreverdb/pull/168) and stacked [#170](https://github.com/Imemoth/wow-foreverdb/pull/170)). The owner explicitly requested the acceptance fix **before moving on to other implementation work**. Treat this as the **single active delivery lane** until its live acceptance / pause decision is recorded.

This does **not** imply that these Draft PRs are ready to merge or deploy. Research and architecture discussion for M1 may proceed in parallel, but no competing production implementation begins until the active lane is released by an explicit decision.

## Ordered milestones and work packages

State vocabulary: IN PROGRESS / NEXT / PLANNED / DISCOVERY / BLOCKED / COMPLETE / SKIPPED. A roadmap candidate is not proof of an existing bug. Priority is a proposal until the owner approves this V1.0.

| Milestone | Work item | Priority | State | Definition / dependency |
| --- | --- | --- | --- | --- |
| Q — active prior commitment | Q-001 — Quest next-pass live acceptance | P0 active | IN PROGRESS / LIVE GATE | Issue #169, PRs #168/#170; closure requires real-client giver provenance and explicit status of other acceptance items |
| M0 — release hygiene | AZR-001 — recoverable off-machine backup | P0 | NEXT, unverified | Encrypted independent copy; verified decryption and scoped restore drill; record owner-only evidence; do not claim full PITR |
| M0 | AZR-002 — release branch / share-link cleanup | P1 | PLANNED | Verify/delete merged temporary branch if safe; verify expired sharing bypass removed; preserve approved rollback deployment |
| M0 | AZR-003 — open-work reconciliation | P0 | NEXT | Inventory PRs/issues, dependencies and the old roadmaps; preserve #165/#127/#152/#151/#150, quests and account/Companion gates; classify rather than batch-close |
| M1 — operational alerting | AZR-004 — G6 → Discord notification MVP | P0 after M0 | DISCOVERY | See [alerting design exploration](news-health-discord-alerting-design.md); independent authorization to implement/deploy |
| M1 | AZR-005 — incident transitions and noise controls | P0 after M0 | PLANNED | CRITICAL open, optional one reminder, RECOVERED; per-source dedupe, retries, 429 handling, failure audit |
| M1 | AZR-006 — delivery verification / blind-spot review | P1 | PLANNED | Synthetic failure/recovery acceptance; verify Discord arrival, recovery, missing heartbeat policy |
| M2 — UX reliability | AZR-007 — News pagination boundaries | P1 | PLANNED (documented observation) | Existing /news?page=11–499 can fall back to page 1; >=500 can show unavailable despite HTTP 200; scope correct bounded UX + unit/E2E and no DB unbounded offsets |
| M2 | AZR-008 — News filters/search/mobile states | P1 | DISCOVERY | Audit before calling any other behavior defective; define measurable fixes |
| M2 | AZR-009 — accessibility/product UX audit | P1 | DISCOVERY | Include [#152](https://github.com/Imemoth/wow-foreverdb/issues/152) accessible name mismatch and dependency constraints; reproduce on current release |
| M3 — verified reference data | AZR-010 — Talent Calculator version/rank coverage | P1 | DISCOVERY | Reconcile [#127](https://github.com/Imemoth/wow-foreverdb/pull/127), 70630/70634 sources; declare confidence/build on fallback data |
| M3 | AZR-011 — Class/Race Guides consistency | P1 | DISCOVERY | Audited source baseline and dated changes; do not invent mechanics or stale abilities |
| M3 | AZR-012 — publication/provenance quality | P1 | DISCOVERY | Independent evidence, observed-position precision and privacy thresholds; do not silently extend schema 9 |
| M4 — growth | AZR-013 — indexing/SEO technical audit | P2 | PLANNED | Canonical, sitemap, robots, structured data and Search Console evidence |
| M4 | AZR-014 — analytics baseline | P2 | PLANNED | Agree sessions, organic entrances, search impressions, clickthrough, return visits; verify tracking consent |
| M4 | AZR-015 — player-intent content strategy | P2 | DISCOVERY | Content gap assessment and source-backed article backlog; no unverified search-volume promises |
| M4 | AZR-016 — navigation/internal link quality | P2 | PLANNED | Information architecture and journeys into class/race/talent/news/zone content |
| M5 — engagement | AZR-017 — new user-facing capabilities | P3 | IDEA INBOX | Only if a real use case, metrics and build/operating cost justify prioritization |
| Separate / optional | AZR-018 — G7 pg_net timeout investigation | P2 | IDEA INBOX | Reassess 0017 revision net timeout only with operational failure evidence, not by default |
| Separate / gated | AZR-019 — global story grouping | P2 | BLOCKED on separate owner decision | Draft PR #165; 4 overrides/0 linked members at last gate; never call news_link_stories without explicit GO |

These work IDs are roadmap tracking IDs, **not** claims that corresponding GitHub issues already exist. Existing issue/PR numbers are canonical where linked.

### Milestone exit gates

- **Q:** owner-reviewed actual-client evidence, explicit PASS/PENDING/FAIL matrix, no unauthorized public activation.
- **M0:** backup/restore evidence, current PR inventory, retired temporary access routes or documented exception.
- **M1:** deliver exactly one actionable critical Discord alert per incident transition; recoveries visible; no alert for healthy inactivity; realistic false-positive, delivery-error and no-heartbeat tests; secrets confined to server-side protected store.
- **M2:** bounded predictable News paging; search/filter consistency; mobile and accessibility regression tests; no fail-open data access.
- **M3:** tested talent/build provenance and guide source confidence, clear unresolved coverage.
- **M4:** accepted dashboard baseline, verified indexability, source-backed content priorities.
- **M5:** validated user need and distinct metric before building a new feature.

## Operating policy: ideas do not silently displace the plan

1. **WIP limit = 1 main delivery initiative.** Separate low-cost DISCOVERY is allowed with a capped, explicitly stated scope. Finish, pause with reason, or close the current work before starting the next implementation.
2. **Every new idea goes into the Idea Inbox first.** Never jump from a conversation brainstorm straight to code, SQL, public deployment or a change of roadmap priority.
3. **Apply an impact test:** user problem, target audience and success metric; value/reach, confidence, engineering effort, recurring cost, security/privacy/data risks, dependencies, and which committed item would move later.
4. **Classify:** REJECTED, PARKED, DISCOVERY, ACCEPTED FOR BACKLOG, or APPROVED CHANGE. Idea acceptance is not implementation authorization.
5. **Priority change requires a short change record:** old/new order, displaced work and timing/risks, owner decision, next action. The owner can intentionally override any priority after the tradeoff is visible.
6. **Fast lane:** confirmed security incident, production outage, likely irreversible data loss or urgent compliance requirement may interrupt WIP; log it and resume/retire the earlier initiative deliberately. Cosmetic excitement is not an exception.
7. **Review this roadmap at every phase exit** and when preparing an implementation prompt; agents must check active WIP and report any proposed deviation before writing code.
8. **Never treat milestones as self-deploying:** Draft PR review, CI, rollback and owner production GO remain separate gates.

When the owner proposes an exciting new feature, the default assistant/agent response is: *"Captured for the AzerDex Idea Inbox. Here is its value, effort and opportunity cost against the currently active milestone; do you want a deliberate reprioritization?"* Do not dismiss the idea or implement it by default.

## Idea Inbox

| Idea | Proposed lane | State | Why not started |
| --- | --- | --- | --- |
| Interactive Discord bot (slash commands, ACK, user actions) | M5 / optional M1 V2 | PARKED | One-way alerting can use a webhook without bot permissions or hosting; bot justified only by verified two-way needs |
| G7 revision job timeout adjustment | Operations | PARKED | Requires actual timeout impact evidence and a separate approval |
| Further News story-grouping behavior | News | PARKED / gated PR #165 | Separate owner decision; no story linking implied |

New ideas should be appended with a date, problem statement, benefit hypothesis, initial effort band, current-work displacement and a review decision. Do not store credentials or personal information.

## Lightweight decision record

| Date | Decision | Reason / effect |
| --- | --- | --- |
| 2026-11-05 | G5 SKIPPED — ACCEPTED HISTORICAL GAP | One verified missing US Dev Notes reply, no material presentational effect; avoid unnecessary production write |
| 2026-11-06 | News V2 G4/G6 COMPLETE; PR #167 merged | Production acceptance and cron monitoring confirmed; Discord delivery remains future work |
| 2026-11-06 | Product Roadmap V1.0 proposed | One active delivery lane and explicit Idea Inbox; Q-001 remains ahead of M1 implementation pending owner review |

## Delivery checklist for each new PR

- Identify item ID and active milestone; map to existing issues/PRs and check dependencies.
- Record scope, exclusions, before-state, acceptance criteria and rollback / revert instructions.
- Keep credentials, private Guildbook/character data, and unapproved feature flags out of the diff.
- Verify tests, code quality, required CI and runtime evidence; mark unknowns clearly.
- No merge, Supabase mutation, production promotion, schedule change or secret edit without the appropriate explicit gate.
- Update roadmap status and decision record after acceptance; never mark proposed work COMPLETE solely from synthetic tests.

**Immediate next action:** complete or explicitly pause Q-001 (#169) live acceptance; then M0 reliability/backlog closure; in parallel **discuss** AZR-004 Discord alerting architecture without writing production code.
