# Admin Platform access-control specification

**Status: PARTIALLY DECIDED — 2026-11-10.** This specification supports [ADM-00 ADR-020](adr-020-admin-platform-adm-00.md) and the [central roadmap](azerdex-product-roadmap.md). The ADR distinguishes **APPROVED** owner decisions from **PROPOSED** design and **OPEN** gates. This specification authorizes no role assignment, schema, migration, production setting or deployment.

## Scope and trust boundaries

Use existing Supabase Auth for staff identity, with a separate server-side authorization decision on every `/admin` request and action. A signed-in website account starts as **User**, with no staff access. Companion technical installation identities and anonymous Auth sessions cannot become staff by virtue of authentication. Neither hiding a control in the UI nor trusting a client-supplied role is enforcement.

The private staff/workflow store, existing private account and operational data, and public read model remain isolated. Draft articles and unapproved media stay private; only an explicitly published revision and its approved assets become public. **Editorial article publishing** changes public content through a future CMS delivery path. It does not deploy application code, invoke the database/public-read publication pipeline, change Cron or secrets, or confer production operator authority. Those actions keep separate permissions, protected environments and owner release gates. The content store and delivery mechanism require an accepted ADM-03 design before implementation.

## Hybrid RBAC: roles and direct grants

**PROPOSED:** a staff account may have **multiple active roles**. Versioned role-to-permission mappings and narrowly controlled **individual grants** form effective permissions, constrained by resource, environment, effective time, account status, revocation, MFA and per-action approval. Optional group-based role inheritance is a later extension through the same evaluation path. Unknown permissions and unavailable policy state deny access. A role label alone is never an authorization check.

| Primary role | Proposed normal capabilities | Boundary |
| --- | --- | --- |
| **User** | Public account and public content only | No `/admin` access by default |
| **Moderator** | In-scope content reports, moderation queue, reasoned decisions and reversal | Cannot publish articles, assign staff or operate production |
| **Editor** | Create/revise News drafts, reusable blocks and media; preview and submit for review | No publish permission by default; only a scoped grant may delegate it; no staff assignment or deployment |
| **Administrator** | Staff workflow administration and bounded role/grant assignment; CMS configuration within approved scope | Cannot self-elevate to Owner or bypass editorial/release approval |
| **Owner** | Final staff and policy authority, approved editorial oversight and recovery | High-risk use requires MFA, audit and explicit action gates; Owner does not turn CMS publish into production deployment |

The full **PROPOSED** role-permission matrix and stable names are in [ADR-020](adr-020-admin-platform-adm-00.md#proposed-authorization-contract). `admin.enter` is necessary but not sufficient. `news.article.publish` is distinct from authoring and `news.article.unpublish`; `news.article.approve_highlighted` is distinct from ordinary review. **APPROVED:** an Editor receives no publishing permission through the Editor role; only an explicit scoped grant may delegate it. `production.deploy`, database/public-read publication and other privileged operations remain outside CMS permissions.

An individual grant identifies one subject, one permission, bounded resource/environment scope, reason or ticket, proposer, approver, start, expiry and revocation state. **PROPOSED policy requiring final owner approval:** delegated `news.article.publish` grants default to 30 days with a 90-day maximum; renewal requires a new reviewed grant. Elevated exceptions expire; no unrestricted wildcard or implicit delegation. The grantor cannot grant above their approved ceiling. Direct grants cannot override suspension, mandatory editorial approval, MFA or separation of duties. Multiple roles must not combine into an action-gate bypass.

## Editorial authorization

**APPROVED:** a delegated Editor may publish their own normal article after validation. Highlighted/high-impact content requires independent approval from another authorized person; its author or substantive editor cannot approve that revision, including when holding Owner. Approval binds to an immutable revision and is invalid after change. Classification cannot be downgraded to evade approval.

**PROPOSED enforcement:** check `news.article.publish` and scope at the side-effect boundary; validate preview and approved media; for highlighted content require a matching independent `news.article.approve_highlighted` decision for the exact unchanged revision. Track classification history and reject bypass downgrades. Separate publish and unpublish authority. Public article, RSS, sitemap and canonical/SEO output must agree after publish, unpublish or rollback, without a code commit or Vercel deployment. Draft and unapproved media remain private. See the [ADR state machine](adr-020-admin-platform-adm-00.md#editorial-state-machine-and-publication-rules); CMS storage and delivery are ADM-03 design gates.

## Staff assignment and initial Owner bootstrap

**PROPOSED:** normal staff assignment is an explicit, audited workflow. Only an authorized Administrator or Owner may propose a bounded assignment; high-risk Administrator/Owner assignments and elevated direct grants require an independent eligible approver, reason and MFA. The subject and proposer cannot approve their own elevation. Protect the last active Owner from ordinary removal or disablement until safe succession. Revoking a role or grant must take effect on the **next server authorization decision**, including an already open session; do not rely on an old JWT claim, stale UI state or a long-lived permission cache. Revoke affected sessions when warranted; recertify access on an approved cadence.

**PROPOSED single-owner bootstrap:** the first Owner is an existing, verified AzerDex Auth account selected through a one-time, operator-run bootstrap procedure during an approved staging/production setup. Bind it to an exact account ID after MFA enrollment and a fresh authentication check; record the actor, target, time and reason in a durable audit record; verify the assignment and disable the bootstrap path immediately. It must not be a public registration route, hard-coded email, reusable token, automatic first-user elevation or general bypass. The owner approves the bootstrap identity and recovery procedure before use.

**PROPOSED:** a single-owner project cannot supply two distinct approvers for its first assignment. That **one-time bootstrap exception** does not waive normal authorization. Until a second eligible approver exists, an Owner may make necessary initial staff assignments through a documented, MFA-gated owner ceremony with explicit reason, out-of-band notification and retrospective review. No non-Owner self-assignment is allowed. After independent approvers exist, high-risk grants follow the normal two-person rule; emergency recovery has a separate short-lived, audited runbook. The owner/security team must approve the ceremony and recovery controls before use.

## Enforcement, audit and MFA

- **PROPOSED:** require staff MFA before `/admin` entry and step-up or fresh authentication for article publish/unpublish, highlighted approval, staff assignment, permission grants and privileged actions. Define factors, freshness and lost-factor recovery before ADM-01.
- Authorize at the API boundary and again immediately before a side effect. Bind the decision to actor, permission, resource, reviewed revision and action; protect approval consumption against replay and races. An unavailable authorization source fails closed.
- Store authorization in a server-controlled source. Do not use editable `user_metadata` or a stale JWT as sole authority. If Supabase is selected, `authenticated` alone is not authorization because anonymous Auth users can carry that database role. Keep privileged tables and `service_role` out of the browser; review RLS, exposed schema grants and any security-definer function separately.
- Audit staff entry and step-up, role/grant proposals, approvals and revocations, editorial draft/review/approval/classification/publish/unpublish/rollback, moderation decisions, denials, bootstrap and recovery. Record actor, subject, scope, revision, outcome, reason and time without secrets, tokens or private article payloads. Set retention and tamper-evidence policy with the owner/security/privacy team.
- Scope operational reads separately. A Moderator or Editor role never inherits publication-pipeline, release, SQL, Cron, secret or deployment capabilities merely because a status panel appears in `/admin`.

## Acceptance for ADM-01 and later gates

- A User and an anonymous/technical identity cannot enter `/admin`; two roles combine only their intended permissions; a direct grant adds exactly its scoped permission and expires or revokes on the next authorization decision.
- An Editor can draft and preview but cannot publish by default. A delegated Editor may self-publish a validated normal revision; highlighted publication needs another eligible person to approve that exact unchanged revision, even if the publisher is Owner. Published revision, RSS, canonical/SEO metadata and sitemap agree; rollback/unpublish updates public outputs without deploying code or running the database publication job.
- Moderator, Editor and Administrator boundaries survive cross-account requests, forged metadata/JWT claims, stale sessions, resource swaps, classification downgrade and concurrent revoke/action attempts. Staff cannot approve their own elevation.
- The initial Owner bootstrap succeeds exactly once for the approved existing account, is audited and then disabled. Normal two-person high-risk grants work once a second approver exists; the interim owner ceremony is MFA-gated and auditable.
- UI, API and storage reject unauthorized draft/media access; private account data never appears in public CMS output. Production deployment and operational mutation remain blocked by their separate controls during CMS acceptance tests.

## Decisions before implementation

The confirmed publishing rules are recorded as **APPROVED** in [ADR-020](adr-020-admin-platform-adm-00.md#approved-owner-decisions). The product/editorial and security owners still need to approve the proposed matrix, grant limits, normal review requirement, staff MFA, audit retention, first Owner identity and bootstrap/recovery procedures before ADM-01 starts. Authorization implementation is an ADM-01 design gate; storage and deployment-independent delivery are ADM-03 gates. Test in staging and review security independently before any release PR.
