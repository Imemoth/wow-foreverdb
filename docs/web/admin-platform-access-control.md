# Admin Platform access-control specification

**Status: PROPOSED — owner/security review, 2026-11-10.** This specification supports the [central roadmap](azerdex-product-roadmap.md) and its `/admin` News CMS sequence. It authorizes no role assignment, schema, migration, production setting or deployment.

## Scope and trust boundaries

Use the existing AzerDex website authentication for staff identity, with a separate server-side authorization decision on every `/admin` request and action. A signed-in website account starts as **User**, with no staff access. Companion technical installation identities and anonymous Auth sessions cannot become staff by virtue of authentication. Neither hiding a control in the UI nor trusting a client-supplied role is enforcement.

The private staff/workflow store, existing private account and operational data, and public read model remain isolated. Draft articles and unapproved media stay private; only an explicitly published revision and its approved assets become public. **Editorial article publishing** changes public content through the proposed CMS delivery path. It does not deploy application code, invoke the database/public-read publication pipeline, change Cron or secrets, or confer production operator authority. Those actions keep separate permissions, protected environments and owner release gates. The proposed content store and delivery mechanism require an accepted ADR before implementation.

## Hybrid RBAC: roles and direct grants

A staff account may have **multiple active roles**. Effective permissions are the union of active permissions from those roles and narrowly controlled **individual grants**, constrained by resource, environment, account status and any explicit suspension. Unknown permissions and unavailable policy state deny access. A role label alone is never an authorization check.

| Primary role | Proposed normal capabilities | Boundary |
| --- | --- | --- |
| **User** | Public account and public content only | No `/admin` access by default |
| **Moderator** | In-scope content reports, moderation queue, reasoned decisions and reversal | Cannot publish articles, assign staff or operate production |
| **Editor** | Create/revise News drafts, reusable blocks and media; preview and submit for review | Article publish is a separate permission; no staff assignment or deployment |
| **Administrator** | Staff workflow administration and bounded role/grant assignment; CMS configuration within approved scope | Cannot self-elevate to Owner or bypass editorial/release approval |
| **Owner** | Final staff and policy authority, approved editorial oversight and recovery | High-risk use requires MFA, audit and explicit action gates; Owner does not turn CMS publish into production deployment |

The role-to-permission matrix is **PROPOSED** and finalized in ADM-00. Example stable permissions: `admin.enter`, `news.draft.write`, `news.media.manage`, `news.review`, `news.article.publish`, `news.article.unpublish`, `moderation.case.decide`, `staff.role.assign`, `staff.grant.approve` and `ops.status.read`. Publish and unpublish permissions should be scoped separately from authoring; the product owner decides whether an Editor may hold the publishing permission by role or by a specific grant. `production.deploy`, database publication and other privileged operations are **outside** these CMS permissions and use their own controls.

An individual grant identifies one subject, one permission, bounded resource/environment scope, reason or ticket, proposer, approver, start, expiry and revocation state. Elevated exceptions expire; no ordinary wildcard grant or implicit delegation. The grantor cannot grant above their own approved ceiling. Direct grants cannot override suspension, a required editorial review, MFA or separation of duties. Multiple roles must not accidentally combine into a bypass of a per-action approval gate.

## Staff assignment and initial Owner bootstrap

Normal staff assignment is an explicit, audited workflow. Only an authorized Administrator or Owner may propose a bounded assignment; high-risk Administrator/Owner assignments and elevated direct grants require an independent eligible approver, reason and MFA. The subject and proposer cannot approve their own elevation. Revoking a role or grant must take effect on the **next server authorization decision**, including an already open session; do not rely on an old JWT claim, stale UI state or a long-lived permission cache. Revoke affected sessions when warranted.

**PROPOSED single-owner bootstrap:** the first Owner is an existing, verified AzerDex Auth account selected through a one-time, operator-run bootstrap procedure during an approved staging/production setup. Bind it to an exact account ID after MFA enrollment and a fresh authentication check; record the actor, target, time and reason in a durable audit record; verify the assignment and disable the bootstrap path immediately. It must not be a public registration route, hard-coded email, reusable token, automatic first-user elevation or general bypass. The owner approves the bootstrap identity and recovery procedure before use.

A single-owner project cannot supply two distinct approvers for its first assignment. That **one-time bootstrap exception** does not waive normal authorization. Until a second eligible approver exists, an Owner may make necessary initial staff assignments through a documented, MFA-gated owner ceremony with explicit reason, out-of-band notification and retrospective review. No non-Owner self-assignment is allowed. After independent approvers exist, high-risk grants follow the normal two-person rule; emergency recovery has a separate short-lived, audited runbook.

## Enforcement, audit and MFA

- Require staff MFA before `/admin` entry and step-up or fresh authentication for article publish/unpublish, staff assignment, permission grants and privileged actions. Define recovery and lost-factor handling before rollout.
- Authorize at the API boundary and again immediately before a side effect. Bind the decision to actor, permission, resource, reviewed revision and action; protect approval consumption against replay and races. An unavailable authorization source fails closed.
- Store authorization in a server-controlled source. Do not use editable `user_metadata` or a stale JWT as sole authority. If Supabase is selected, `authenticated` alone is not authorization because anonymous Auth users can carry that database role. Keep privileged tables and `service_role` out of the browser; review RLS, exposed schema grants and any security-definer function separately.
- Audit login to staff areas, role/grant proposals, approvals, revocations, editorial draft/review/publish/unpublish, moderation decisions, denials and recovery. Record actor, subject, scope, revision, reason and time without secrets, tokens or private article payloads. Set retention and tamper-evidence policy with the owner.
- Scope operational reads separately. A Moderator or Editor role never inherits publication-pipeline, release, SQL, Cron, secret or deployment capabilities merely because a status panel appears in `/admin`.

## Acceptance for ADM-01 and later gates

- A User and an anonymous/technical identity cannot enter `/admin`; two roles combine only their intended permissions; a direct grant adds exactly its scoped permission and expires or revokes on the next authorization decision.
- An Editor can draft and preview but cannot publish without the separate editorial permission and required review. A published revision, RSS, canonical/SEO metadata and sitemap agree; rollback/unpublish removes or updates the public representation without deploying code or running the database publication job.
- Moderator, Editor and Administrator boundaries survive cross-account requests, forged metadata/JWT claims, stale sessions, resource swaps and concurrent revoke/action attempts. Staff cannot approve their own elevation.
- The initial Owner bootstrap succeeds exactly once for the approved existing account, is audited and then disabled. Normal two-person high-risk grants work once a second approver exists; the interim owner ceremony is MFA-gated and auditable.
- UI, API and storage reject unauthorized draft/media access; private account data never appears in public CMS output. Production deployment and operational mutation remain blocked by their separate controls during CMS acceptance tests.

## Decisions before implementation

The product owner approves editorial states, publishing authority and the first Owner identity; the security owner approves MFA, role/grant policy, bootstrap/recovery and revocation semantics; the editorial and moderation owners approve content workflows; operations/release owners approve only their separately scoped integrations. Record the storage and deployment-independent delivery choice in an ADR marked **PROPOSED** until owner acceptance. Test in staging and review security independently before any release PR.
