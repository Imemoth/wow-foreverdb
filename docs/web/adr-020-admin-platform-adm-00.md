# ADR-020 — ADM-00 Admin Platform architecture and governance

**Status:** PARTIALLY DECIDED, 2026-11-10. Only the items labelled **APPROVED** below are product-owner decisions. The role mapping, controls and implementation choices labelled **PROPOSED** require the indicated approvals; **OPEN** items block the relevant gate. This record extends [ADR-008](architecture-decisions.md#adr-008--git-managed-markdown-editorial-content-accepted) without replacing its current Git-managed News delivery. It is the ADM-00 decision record for the [central roadmap](azerdex-product-roadmap.md) and [access-control specification](admin-platform-access-control.md).

## Context, goals and boundary

AzerDex needs a manually operated `/admin` News CMS in which staff can draft, review and publish content without a code commit or Vercel deployment. Existing Supabase Auth supplies identity, not staff authority. The private account/Companion/Guildbook database, the public read database and its publication worker, and the website release process are distinct trust domains. The CMS must keep drafts and unapproved media private and expose only an authorized published revision and approved assets. The ADM-00 goal is a reviewable authorization and editorial contract before ADM-01, while leaving storage and delivery architecture to explicit later gates.

## Approved owner decisions

The following are **APPROVED** product rules; no other part of this ADR gains approval by association:

1. An Editor has no publishing right by default. An explicit, scoped permission grant may delegate editorial publishing.
2. A delegated Editor may publish their own **normal** article after required validation.
3. A highlighted or otherwise high-impact article needs independent approval from another authorized person. Its author or substantive editor cannot approve that revision. An Owner cannot self-approve merely because of the Owner role.
4. Approval binds to one immutable article revision and is invalid if that revision changes. Classification cannot be downgraded merely to evade mandatory approval.
5. Editorial content publication does not grant or invoke application deployment, database/public-read publication jobs, or other privileged operations.

## Proposed authorization contract

**PROPOSED.** The system roles are **User**, **Moderator**, **Editor**, **Administrator** and **Owner**. A person can have multiple roles. Role-to-permission mappings are versioned and changed through reviewed policy updates; controlled individual grants add only named permissions. Optional group-based role inheritance is a later extension and must use the same evaluation path. No role name, frontend menu, editable user metadata or JWT claim alone authorizes an action.

The server evaluates the effective permission at every protected entry and immediately before each side effect. It uses active role mappings and individual grants for the authenticated account, intersects them with resource, environment and time scope, then applies account suspension, revocation, MFA and action-specific separation-of-duties rules. Unknown permission, missing policy state or failed check means **deny**. A version or revocation change must be visible at the next protected authorization decision, including for an already open session; any cache must preserve that guarantee. No unrestricted permission wildcard exists. A grantor cannot delegate beyond an approved ceiling, approve their own elevation or use a second role to bypass an action gate. Application roles convey no automatic production or database privileges.

Permissions below are stable proposed names. `admin.enter` is necessary for staff entry, never sufficient for an action. `news.article.publish` is an editorial permission only. `ops.status.read` is read-only and scoped to explicitly approved status data. **All matrix cells are PROPOSED**, except the approved constraint that Editor publishing is never a default role permission. `G` means eligible only through an individually approved scoped grant; `—` means no default role permission.

| Area / permission | User | Moderator | Editor | Administrator | Owner |
| --- | --- | --- | --- | --- | --- |
| Entry `admin.enter` | — | ✓ | ✓ | ✓ | ✓ |
| News `news.draft.write`, `news.article.preview` | — | — | ✓ | — | — |
| News `news.article.submit`, `news.article.review` | — | — | ✓ | — | — |
| News `news.article.classify` | — | — | ✓ | — | — |
| News `news.article.approve_highlighted` | — | — | G | ✓ | ✓ |
| News `news.article.publish` | — | — | G | G | ✓ |
| News `news.article.unpublish` | — | — | G | ✓ | ✓ |
| Media `news.media.manage`, `news.media.validate` | — | — | ✓ | — | — |
| Moderation `moderation.case.read`, `moderation.case.decide`, `moderation.case.reverse` | — | ✓ | — | — | — |
| Staff `staff.role.propose`, `staff.grant.propose` | — | — | — | ✓ | ✓ |
| Staff `staff.role.approve`, `staff.grant.approve`, `staff.access.revoke` | — | — | — | G | ✓ |
| Audit `audit.editorial.read`, `audit.staff.read` | — | — | G / — | ✓ / ✓ | ✓ / ✓ |
| Read-only Operations `ops.status.read` | — | — | — | G | G |

The matrix does not itself approve assignments. `G` requires an explicit grant even when the person has that role. Approval permissions are subject to independence rules and cannot authorize one's own revision or staff elevation. `news.article.review` records review and cannot substitute for `news.article.approve_highlighted`. Permission scopes include article or collection, action, environment, start and expiry as applicable. Every direct grant records subject, permission, scope, reason/ticket, proposer, approver, effective time, expiry and revocation. **PROPOSED policy requiring final owner approval:** delegated `news.article.publish` grants default to 30 days and may last no longer than 90 days. Renewal is a new reviewed grant, never an implicit extension.

`production.deploy`, database/public-read publication, SQL mutation, Cron/secret changes and other privileged operations are **outside** this CMS matrix. They require their existing separate identities, approvals, protected environments and release gates. A status panel or an Owner role does not imply those capabilities.

## Editorial state machine and publication rules

**PROPOSED state names and transitions:** `Draft → In Review → Approved → Published → Archived / Unpublished`. A review can return a revision to Draft; an approved revision can be returned or superseded; unpublishing/archiving can retain a private revision history. For a normal article, Approved records completed validation and may be entered by its authorized publisher if the final editorial policy permits self-publishing; it does not assert a second person's review. For highlighted/high-impact content, Approved requires the independent revision-bound approval. Each content change creates a new immutable revision ID. The workflow must record article ID, revision ID, classification, actor and transition. State alone never grants permission; every transition checks the action permission and current revision.

| Path | Required actions and checks |
| --- | --- |
| Normal article | Author drafts and previews, validates content and approved media, then submits. A delegated Editor with an active scoped `news.article.publish` grant may publish their own validated normal revision. Other authorized publishers still require the same validation. A separate review or Approved state may be required by final editorial policy; this is **OPEN**. |
| Highlighted / high-impact article | Author drafts and submits an immutable revision. Another person with `news.article.approve_highlighted` reviews that exact revision, validates its preview/media and records an approval. That approver cannot be its author or substantive editor, including when they hold Owner. An authorized publisher may publish only the unchanged approved revision after rechecking the approval and current classification. If no independent eligible approver exists, publication waits. |
| Change after approval | Any content, metadata, media, classification or SEO change creates a new revision and invalidates the earlier revision's approval for publication. A changed revision returns to the applicable review path. |
| Classification downgrade | Classification is tracked with revision history. A downgrade cannot erase a prior highlighted/high-impact requirement to circumvent review; it needs a separately authorized, reasoned classification decision, recorded in audit, under a policy set before ADM-03. Until then, the stricter approval requirement applies. |
| Unpublish / rollback | A separately authorized `news.article.unpublish` action removes the public revision and updates dependent outputs. Rollback selects a previously validated revision through the current approval rules; a past approval is not automatically reusable after intervening changes. Both actions are audited and testable. |

**PROPOSED delivery invariants:** preview resolves only private drafts and approved media for authorized staff, with no public caching or indexing. Media provenance, rights, alt text, type and size checks precede publish. The public article, RSS, sitemap, canonical URL and SEO metadata must move coherently to the same published revision, including on unpublish and rollback. No draft, unapproved asset, private account record or Guildbook datum may leak through public pages, feeds, caches or the public read model. Publishing content must work without a code commit or Vercel deployment. The storage, consistency/atomicity and cache invalidation design is **OPEN** for ADM-03; this ADR chooses no CMS database, asset store, publication job or endpoint.

Audit events must cover draft creation and revision, classification change, review/approval/rejection, validation result, grant use, publish, unpublish, rollback and denied attempts. Each records actor, time, article/revision, action, outcome, reason and relevant grant/approval identifiers without storing secrets or private article payloads in the audit trail.

## Security and staff administration

**PROPOSED security invariants:** Supabase Auth is the existing identity foundation. A verified, active, non-anonymous account and staff MFA are required for `/admin`; fresh/step-up authentication is required for publish/unpublish, highlighted approval, staff assignment, grant approval and recovery. The exact MFA factors, age window and recovery method are **OPEN** for security/owner approval. Staff authorization state is private and server-controlled. A stale JWT, user-editable metadata, `authenticated` database role or hidden menu is insufficient; a live protected decision must see revocation. Private staff data and draft/media storage must have separately reviewed access boundaries, with no privileged key in the browser. Supabase exposed schema grants/RLS and any privileged database functions need review in ADM-01/03 if used. The public read database continues to contain only its approved aggregate allowlist, never staff state or Guildbook data.

**PROPOSED lifecycle:** role and grant requests record requester, target, scope, reason and expiry. An authorized approver checks the proposed ceiling and conflicts, uses step-up authentication, and records an immutable decision. Administrator/Owner assignment and elevated grants require independent eligible approval; subject and proposer cannot approve their own elevation. Suspension and revocation are audited, take effect on the next protected authorization decision, and trigger session invalidation when warranted. Periodic access review removes stale assignments. The last active Owner cannot be removed or disabled through ordinary administration before a safe successor exists.

**PROPOSED one-time bootstrap:** an operator selects the owner-approved, existing verified account by exact ID, verifies fresh authentication and MFA, assigns the initial Owner once, writes a durable audit event and disables the bootstrap path. It is never public registration, automatic first-user promotion, hard-coded email or reusable token. A single Owner cannot provide two distinct approvers initially, so a documented, MFA-gated initial assignment ceremony with reason, out-of-band notice and retrospective review is proposed until a second eligible approver exists. Subsequent protected assignments use independent approval. Lost-owner recovery needs a separate short-lived, audited procedure and cannot bypass last-Owner protection silently. The exact identity, operator controls, ceremony and recovery runbook are **OPEN** before ADM-01.

**PROPOSED audit policy:** capture staff authentication/step-up outcomes, authorization denials, role/grant proposals, approvals, expiry and revocations, bootstrap/recovery, editorial events and moderation decisions. Protect against alteration, limit audit readers, and avoid credentials and sensitive payloads. Retention length, export, deletion and incident access rules remain **OPEN** for owner/security/privacy approval.

## Open decisions and phase gates

| Gate | Decision still needed | Accountable approval |
| --- | --- | --- |
| Before ADM-01 implementation | Accept or revise the five-role defaults and permission matrix; decide highlighted approver eligibility, Administrator/Owner editorial publish defaults, grant ceilings, 30/90-day publishing policy, and staff/group extension priorities. | Product/editorial owner and security owner |
| Before ADM-01 implementation | Approve staff MFA/step-up and recovery policy, role/grant lifecycle, retention/audit controls, first Owner account and one-time bootstrap/recovery runbooks. Name the accountable staff/security owners. | Product owner and security/privacy owner |
| ADM-01 design gate | Choose private authorization data model, versioning, evaluation and immediate-revocation mechanism; specify policy/RLS and tests without weakening existing Account/Auth boundaries. | Security/data design review |
| Before ADM-02 completion | Approve article types, media rights/provenance and retention, substantive-edit definition, classification authority and normal-article review requirement. | Product/editorial owner |
| ADM-03 design gate | Select the deployment-independent CMS content/asset storage and public delivery path, atomic publish/unpublish/rollback, cache/feed/SEO consistency and failure recovery. Keep it distinct from the existing database publication worker. | Product/editorial, security/data and operations design review |
| Before ADM-04/05 rollout | Define moderation scope and appeals, approved read-only operations surfaces, recertification cadence and explicit launch/rollback GO. | Moderation, operations/release and product owners |

## Scope, consequences and acceptance

This ADR documents ADM-00 only. It does not create production schema, secrets, roles, privileged endpoints, CMS delivery architecture or a deployment; it does not implement ADM-01 or change `release`. The hybrid model gives narrow delegation and multiple-role flexibility, at the cost of versioned policy administration, per-action server checks, stronger audit and careful revocation. Independent highlighted approval may delay publication when staffing is thin. Deployment-independent publishing requires a later content-delivery design and explicit consistency tests.

ADM-00 is **documentation complete but decision acceptance pending** when this ADR, the access-control specification and central roadmap agree on approved versus proposed rules, permission names, editorial transitions, trust boundaries and open gates. ADM-00 is **accepted** only after the named owners resolve and approve its pre-ADM-01 policy decisions. ADM-01 may then build authorization and `/admin` foundations; ADM-02 builds private News drafting/media; ADM-03 designs and implements editorial delivery; ADM-04 adds moderation/read-only operations; ADM-05 validates staged rollout. Each phase has its separate acceptance evidence and production GO in the [roadmap](azerdex-product-roadmap.md#centralized-admin-platform-adm-00adm-05).
