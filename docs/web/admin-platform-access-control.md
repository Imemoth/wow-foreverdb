# Admin Platform access-control specification

**Status: PROPOSED — architecture and policy for owner/security review (2026-11-10).** Linked from the [central roadmap](azerdex-product-roadmap.md). This is a specification, not authorization to add users, roles, schema, secrets or a production console.

## Boundary and principals

The Admin Platform is for named human operators. Existing public website accounts and Companion technical installation identities gain no admin rights by being authenticated. Deny anonymous and disabled accounts. Authenticate through the existing approved identity provider, then authorize on the server for **every request and every action**. UI visibility is only a convenience. Public read-model, private Guildbook, publication and production control boundaries remain independent.

**PROPOSED model:** a user has zero or more assigned roles, each role maps to versioned permissions, and a controlled direct grant can add a specific permission to that individual. Effective permissions are the union of active role permissions and active direct grants, constrained by resource scope, environment and explicit denies/suspension. No direct grant may exceed the grantor's delegated ceiling or override a separation-of-duties rule. Wildcard permissions are forbidden for ordinary operators. A role name is not itself a policy check; use stable permission identifiers such as `news.health.read`, `admin.access.propose`, `admin.access.approve`, `publication.dry_run` and `publication.execute`. `publication.execute` is a distinct high-risk permission, never implied by a read role.

| Proposed role | Example scope | Authority boundary |
| --- | --- | --- |
| Viewer | Operations status, redacted audit | Read only |
| News operator | News health and reviewed content operations | No publication or access administration |
| Release operator | Release evidence and publication dry-run | Production execute still requires per-action approval |
| Access administrator | Propose, assign and revoke bounded roles/grants | Cannot approve own high-risk grant or bypass audit |
| Security approver | Approve high-risk grants and review audit | No automatic publication authority |

These names and mappings are **PROPOSED**; ADM-00 must establish the actual capability inventory. Do not equate a Discord Operations Bot operator with a website administrator. External bot credentials remain independently scoped.

## Grant lifecycle and enforcement

1. A direct grant names subject, one permission, resource/environment scope, reason or ticket, proposer, approving authority, start and expiry. Default expiry is required for elevated exceptions; owner sets maximum duration. The platform rejects ambiguous or unknown permissions.
2. High-risk grants and role assignments require a second authorized approver who is not the subject or proposer. Self-assignment, self-approval, privilege delegation loops and grant chaining are denied. Emergency access needs a separately approved break-glass runbook with short expiry and immediate review.
3. Revoke and expiry take effect at the authorization source promptly. Do not rely only on mutable `user_metadata` or an old JWT claim. Proposed implementation should check current server-held assignment state on sensitive actions and define cache invalidation/session revocation latency. An unavailable policy store fails closed.
4. Check authorization both at the API boundary and immediately before a side effect. Bind the decision to actor, permission, resource and requested action; use idempotency and race-safe approval consumption for high-risk actions. Never accept a caller-provided role or tenant ID as proof.
5. Record proposal, approval, denial, assignment, use, expiry and revocation with actor, subject, scope, timestamp and reason, excluding tokens, private payloads and secrets. Restrict audit reads, retention and deletion by an owner-approved policy. Detect missing logs and alert through a separate operational channel.

**PROPOSED persistence choice:** an unexposed private authorization schema with least-privilege server access, RLS defense in depth, and narrowly scoped APIs. If Supabase is chosen, `authenticated` alone is not authorization; anonymous Auth users also receive that database role. Do not expose privileged tables or `service_role` to the browser. Any security-definer function needs a fixed search path, explicit caller validation and restricted EXECUTE. No schema, SQL grant or migration is selected by this document; validate against current Supabase documentation before implementation.

## Acceptance matrix before ADM-01/02 exit

- Two roles combine permissions as expected; a direct grant adds exactly one scoped permission and expiry removes it.
- A user with no assignment, anonymous technical identity, suspended user, wrong environment, wrong resource and cross-account request are denied.
- Subject/proposer cannot approve their own elevation; approver without delegation ceiling cannot grant it; role removal and direct-grant revocation take effect within the agreed bound even with a stale session.
- A missing policy store, forged JWT/user metadata, replayed approval and concurrent revoke/action fail closed or produce one audited authorized action, never a silent bypass.
- UI, API and database boundaries all reject unauthorized reads and writes. Tests cover protected publication and News actions separately, without executing production writes.

## Decisions needed before implementation

The product owner approves admin capabilities and named operators; security owner approves role/grant policy, high-risk classification and session freshness bound; operations/data owners approve each source-system integration, audit retention and rollback; release owner separately approves any production mutation capability. Record these decisions in an ADR marked **PROPOSED** until accepted, with staging evidence and an independent security review before any release PR.
