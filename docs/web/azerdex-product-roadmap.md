# AzerDex Product & Engineering Roadmap

**Status:** PROPOSED for owner acceptance, 2026-11-10. **Production source:** `release` at `f703608` (News World First feature, #178). `main` is the integration branch; a merge of `release` into `main` does not promote production. This document is the central *forward-looking* priority and dependency ledger. It does not change production authorization.

## Evidence and existing ledgers

- [Website P1–P3 ledger](azerdex-roadmap.md) records earlier beta milestones and acceptance, not the current queue. [ForeverDB roadmap](../ROADMAP.md) retains Addon, Companion, Account and privacy history and their live gates. Neither is superseded as an evidence record.
- [News G4/G5/G6 execution](g4-g5-g6-execution-log-2026-11-05.md): G2 monitoring, G4 website and G6 15-minute health job completed; G5 historical backfill was skipped with owner acceptance. The four-schema backup is not a verified off-machine recovery/PITR plan. A scheduled health assertion does not itself deliver Discord alerts.
- Draft [PR #172](https://github.com/Imemoth/wow-foreverdb/pull/172) supplied the WIP/Idea Inbox rule, AZR-001–019 backlog and Discord incident acceptance ideas. Its `2c8ccd6` release baseline and webhook-first recommendation are stale. **This consolidated document is proposed to supersede #172's roadmap and alerting design after owner review; leave #172 open until the owner decides whether to close or retarget it.** The owner-selected bot design is in Draft [#174](https://github.com/Imemoth/wow-foreverdb/pull/174), not in #172.
- Code on `release` includes the Quest Tracker 0.7.1 line (#173), Companion 0.9.11-alpha work (#176), Schema 9 C0c offline/SQL tests (#177), News V2, launch articles and #178. Their presence in the branch does not prove owner live acceptance or production deployment of every component. Check the exact release SHA and deployment before asserting a feature is live.

## Priority and branch policy

**One main implementation lane at a time** is the proposed default. Scoped discovery may run alongside it. The owner explicitly allowed #174 bot work in parallel with Quest Tracker; that exception is recorded rather than treated as a new default. A confirmed outage, security incident or likely data loss may interrupt the lane with a recorded decision. New ideas enter the Idea Inbox with user problem, value, confidence, cost, risks, dependencies and displaced work. Changing priority requires the owner's dated decision.

`release` remains the protected production source. Feature, security and Dependabot work normally targets `main`; promote only a curated, reviewed release candidate or hotfix from the current `release` baseline. Never infer release readiness from a green `main` build. Both protected branches require the same ten GitHub checks; publication and live Vercel parity run only on a trusted `release` ref with their protected environments. The weekly schedule on default `main` only dispatches the release workflow and holds no Vercel secret. Publication remains manual, dry-run by default, with a separate owner GO for writes. Do not change Vercel Production Branch Tracking as part of this roadmap. See [branch governance](branch-governance-20261103.md), [release gates](release-gates.md) and [release parity](release-parity.md). Environment restrictions, reviewer policy and Vercel tracking require owner verification in Settings; repository YAML is not proof of those settings.

## Current delivery and dependency ledger

Status is a planning claim, not automatic merge or deployment approval. Owners below are *decision roles* until named people are assigned.

| Lane / item | Current state and dependency | Exit evidence / decision owner |
| --- | --- | --- |
| Q-001 Quest live acceptance ([#169](https://github.com/Imemoth/wow-foreverdb/issues/169)) | 0.7.1 code is in release; earlier stacked #168/#170 are no longer open. Real-client provenance, reward and kill-observation acceptance remains a separate gate. | Product owner records actual-client PASS/PENDING/FAIL and safe scope before further public data use. Addon lead supplies evidence. |
| C0c Schema 9 and Companion | #176/#177 merged to release; offline and SQL acceptance are stronger than earlier drafts. No hosted or Windows live acceptance inferred. | Companion lead + owner verify real-client payload, upload boundary and account/Guildbook isolation before any activation. |
| Ownerless ingest and map atlas | Draft [#179](https://github.com/Imemoth/wow-foreverdb/pull/179), [#180](https://github.com/Imemoth/wow-foreverdb/pull/180), integration-only [#181](https://github.com/Imemoth/wow-foreverdb/pull/181); #181 is not a release candidate. `0019` migration and production anonymous ingest remain unapproved/unverified. | Owner Windows acceptance, security review and separately approved backend validation/migration plan. Preserve Guildbook local-only and Auto Sync OFF. |
| AZR-001/003 release hygiene | Independent encrypted off-machine backup/restore evidence and current PR triage remain open. | Operations owner records restore drill and dispositions before dependent production data changes. |
| AZR-004 Operations Bot | Draft [#174](https://github.com/Imemoth/wow-foreverdb/pull/174): owner chose full Discord bot, Cloudflare Workers/D1, read-only monitoring and independent heartbeat. Staging tests exist; production bot, channel, D1 and heartbeat do not. This replaces #172's webhook-first proposal. | Operations owner reviews unresolved staging cases, fallback and secret rotation, exact-head CI, rollback and separately grants production GO. No production Supabase grant inferred. |
| News story grouping | Draft [#165](https://github.com/Imemoth/wow-foreverdb/pull/165); existing overrides do not authorize linking or public behavior. | News/data owner approves migration, link run and release promotion separately after dry-run and rollback review. |
| Dependencies and reference data | Draft #150/#151/#158/#159, Priest Shadow #127, Nozdormu adapter #124, Atlas Exporter #74/#75. | Respective owners rebase/retarget against the intended branch, run exact-head tests and decide licensing/data coverage; no batch merge. |

## Admin Platform milestones (ADM-00–ADM-05)

The platform is **PROPOSED**. No admin schema, authorization service, console, role assignments or privileged API is authorized by this roadmap. [Admin access-control specification](admin-platform-access-control.md) defines the proposed hybrid RBAC contract and negative tests.

| Milestone | Dependency / accountable decision | Acceptance criteria |
| --- | --- | --- |
| **ADM-00 — inventory and threat boundary** | Product owner names admin operators and data owners; security lead inventories existing Auth, server credentials, publication, News health and audit paths. Precedes all admin code. | Approved capability inventory, sensitive-data classification, trust boundary, non-goals, break-glass and recovery owner; explicit choice of which existing operations can enter the console. |
| **ADM-01 — identity and authorization core** | ADM-00; security lead proposes persistence and session model for **multiple roles per user plus controlled individual grants**. Architecture remains PROPOSED pending ADR and owner approval. | Default deny; server-side effective-permission evaluation; roles and grants scoped, time-bounded where needed, revocable; no editable user metadata or stale JWT alone as authority; cross-account, anonymous and revoked-session tests pass. |
| **ADM-02 — assignment and audit workflow** | ADM-01; product owner decides who may assign roles and who may approve exceptions; security owner approves separation of duties. | Two-person approval for high-risk grants, reason/ticket/expiry, immutable or tamper-evident audit trail, safe revoke and emergency procedure; no self-escalation or unbounded grant. |
| **ADM-03 — read-only operations console** | ADM-01/02 and source-specific least-privilege reads; operations owner decides panels. | Authorized News health, publication status and release evidence visible with redaction, pagination and freshness; unauthenticated, wrong-scope and expired access denied; no mutation capability. |
| **ADM-04 — guarded actions** | ADM-03 plus separate per-action runbooks, protected environment and rollback; release owner decides each action. | Explicit confirmation, scoped permission, dry-run/preview, idempotency, audit and independent approval for publication, job or content mutations. No direct database-write console shortcut. |
| **ADM-05 — rollout and operations** | ADM-01–04 accepted in staging; product and security owners jointly decide production scope. | Threat review, pen/abuse and accessibility tests, monitored staged rollout, access recertification, incident runbook and rollback; separately approved production configuration and promotion. |

**Ownership decisions still required:** named product, security, operations and data owners; which role can approve individual grants; whether an admin UI may ever initiate publication; retention of access and audit records; which source systems are in scope. No table/role design below is an adopted architecture decision.

## Later product work and Idea Inbox

Carry forward #172's AZR-007–016 as discovery or planned work: bounded News pagination and filters, accessibility issue [#152](https://github.com/Imemoth/wow-foreverdb/issues/152), talent/guide provenance, publication quality, SEO/indexability, consent-aware analytics, content and navigation. Reproduce each observation on the current release before filing a defect or declaring completion. AZR-017 (new user features) and AZR-018 (G7 timeout) remain ideas pending value or incident evidence. AZR-019 is gated by #165. The Nozdormu Discord adapter #124 is a separate external-use proof of concept; it is not the Operations Bot. Avoid a second bot roadmap.

| Idea | State | Decision trigger |
| --- | --- | --- |
| Admin Platform beyond read-only operations | PROPOSED | ADM-00 owner scope and security review |
| G7 timeout tuning | PARKED | Verified operational impact |
| New public features / interactive bot extensions | PARKED | User need, success metric and operating cost |

At each phase exit, update this ledger with exact branch/commit, test and live evidence, open decisions and owner approval. CI, a Draft PR and synthetic tests never substitute for release or production GO.
