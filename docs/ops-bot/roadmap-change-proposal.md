# Roadmap changes required by the full-bot decision (proposal for the owner / PR #172 author)

PR #172 (`docs/azerdex-product-roadmap-20261106`) was **not** modified by this workstream. Apply these edits there when convenient, or merge this PR first and rebase #172 over it. The two PRs do not touch the same files: this one adds `docs/ops-bot/**` and `ops-bot/**`.

## 1. `docs/web/news-health-discord-alerting-design.md`

- Change **Status** to: `SUPERSEDED in part by ADR-AZR-004 (docs/ops-bot/design-decision-record.md). Retained for the discovery record.`
- Replace the section "Decision recommendation: Discord incoming webhook first, not a bot" with: *"Decision (owner, 2026-11-06): full Discord bot on Cloudflare Workers with D1 state, read-only Supabase monitoring and an independent external heartbeat. See ADR-AZR-004. The webhook-first recommendation below is retained only as history."*
- Keep unchanged: "Current truth", the state-machine/policy proposal (implemented as specified, see ADR), the security and data-separation rules, and the acceptance criteria (mapped to tests in [test-evidence.md](test-evidence.md)).
- Pattern A (Supabase-only) is **not** selected; pattern B (independent monitor) is selected, with the external heartbeat as the mandatory blind-spot cover.
- In "Decisions required BEFORE coding": answers recorded as: (1) destination = dedicated private Discord channel, owner to supply; (2) critical-only pages, warnings visible in `/azerdex status`; (3) no mentions by default; (4) independent monitor from day one; (5) provider = Healthchecks.io-compatible, cost and latency to be confirmed in staging.
- "Non-goals": remove "deploy a Discord bot, respond to slash commands" (now in scope, read-and-acknowledge only); keep the rest.

## 2. `docs/web/azerdex-product-roadmap.md`

| Where | Change |
| --- | --- |
| Milestone table, AZR-004 | Definition: `G6 -> Discord operations bot V1 (ADR-AZR-004). Draft PR on branch feat/azerdex-ops-discord-bot-v1; staging validation and owner production GO still required.` State: `IN PROGRESS (parallel, owner-approved exception) / NOT DEPLOYED`. |
| AZR-005 | Mark `implemented in the AZR-004 Draft PR (dedupe, reminder throttling, recovery confirmation, 429 handling, audit); acceptance in staging pending`. |
| AZR-006 | Unchanged: delivery verification and blind-spot review remain staging and production gates. |
| Idea Inbox | Row "Interactive Discord bot": state `PARKED` -> `ACCEPTED / SUPERSEDED BY ADR-AZR-004`; "Why not started" -> `Owner chose the full bot on 2026-11-06; implementation is a parallel Draft PR.` |
| Existing active owner commitment | Add: *"Exception recorded 2026-11-06: AZR-004 may be developed in parallel as an isolated, non-production workstream. Q-001 remains the single active LIVE/delivery lane; no production activation of AZR-004 without its own owner GO."* |
| Lightweight decision record | Add row: `2026-11-06 | Full Discord bot (Workers + D1 + read-only Supabase + external heartbeat) selected over webhook-first | Two-way ack/status and an independent failure domain are required; parallel isolated development authorized, no deployment`. |
| M1 exit gate | Keep as written. Add: `plus: independent heartbeat detects a stopped bot; Discord delivery failure reaches the fallback route; no real Supabase data is read before the reporting endpoint is separately approved.` |
| Delivery checklist | No change: the bot PR follows it (item id AZR-004, rollback in [rollback-plan.md](rollback-plan.md), no secrets in the diff). |
| Non-goals in the alerting design / "Immediate next action" | Replace "discuss AZR-004 without writing production code" with "AZR-004 implementation exists as a Draft PR; production remains gated". |

## 3. What does not change

Q-001 priority, M0 hygiene items (AZR-001 off-machine backup, AZR-002, AZR-003), the WIP-limit policy and Idea Inbox rules, and every production safety gate.
