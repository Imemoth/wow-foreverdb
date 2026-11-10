# ADM-01A — Admin security architecture and RBAC implementation plan

**Status: PROPOSED technical plan, 2026-11-10.** [ADR-020](adr-020-admin-platform-adm-00.md) is **OWNER APPROVED at the product-policy level**. This plan does not approve a schema, MFA integration, recovery ceremony, production access or CMS delivery design. ADM-01A is the security/data design gate for a later ADM-01B implementation PR; it makes no database, Auth, application or environment change.

## Baseline and intended outcome

- Existing Supabase Auth is the identity source. The current Account BFF keeps its sealed session in an HttpOnly cookie with `Path=/account`; its server-side session resolution asks Auth for the user on protected requests. Account RPCs use a live `auth.sessions` guard. See [Account architecture](../account-v1/architecture.md#5-web-session-design) and [security](../account-v1/security.md). `/admin` cannot assume that `/account` cookie will be sent to it.
- `private` data, the public read PostgreSQL database, the website's public data adapter, the publication worker and `release` deployment credentials remain separate. No Admin role is a database role or a production operator identity.
- ADR-020 fixes five roles, multiple roles, scoped individual grants, Editor/Administrator publish by grant, Owner normal publish, independent highlighted approval, 30/90-day publish grants, TOTP/AAL2, critical-action freshness of at most 15 minutes, next-decision revocation, one-time Owner bootstrap, last-Owner protection and a 365-day audit baseline. The detailed matrix rows beyond those policy decisions need security review.

**ADM-01A output:** a reviewed logical schema, authorization algorithm, Auth/MFA and `/admin` session boundary, bootstrap/recovery design, audit/privacy plan, threat model and negative-test contract. Record approvals or rejected alternatives in this plan or a follow-on technical ADR before ADM-01B. Do not treat a Draft PR or green CI as security approval.

## 1. Private authorization data model — proposed

Keep the authorization source in an **unexposed, server-controlled schema** in the existing private Supabase project. Decide whether to use the current `private` schema or a dedicated unexposed Admin schema at security/data review. Never place it in the public read database. The following are logical entities, **not migration instructions**:

| Entity | Minimum contract | Invariants to prove |
| --- | --- | --- |
| Policy version and role permissions | Immutable version ID, explicit permission names, role, effective state, approval/audit reference | Exactly one active mapping; reviewed activation is atomic; unknown permission and missing mapping deny. No wildcard. |
| Staff role assignment | Auth user ID, role, scope/environment, start, expiry or review date, proposer, approver, reason, status, revision | Multiple roles allowed; no implicit staff role from Auth or editable metadata; revoked/expired assignment does not authorize. |
| Individual permission grant | Auth user ID, named permission, resource/environment scope, effective/expiry times, proposer, independent approver, reason/ticket, status | Scoped Editor and Administrator `news.article.publish`; specific Editor `news.article.approve_highlighted`; 30-day default/90-day maximum for delegated publishing; expiry and revocation audited. |
| Authorization change marker | Subject or policy revision changed with each activation, assignment, grant or revocation | Cached decisions cannot outlive a change; next protected decision sees committed revocation. The final cache/no-cache design is open. |
| Editorial approval reference | Actor, article ID, immutable revision ID, classification and decision reference | Independent approver; author/substantive editor cannot approve own highlighted revision; revision change invalidates approval. ADM-03 owns the content data model. |
| Bootstrap/recovery control | One-time bootstrap state, exact target ID, operator/approver references, use and disable times; separate recovery record | Atomic single use, last-Owner guard and no reusable public bypass. First identity and mechanism require separate approval. |
| Audit event | Event ID, actor, subject/resource, permission, action, outcome, policy/grant/revision references, timestamp, request ID, reason code | Append-only or equivalently tamper-evident, restricted reader, no token/TOTP secret/private article body. 365-day baseline with privacy-reviewed exceptions and deletion. |

Physical design review must inspect existing exposed schemas, grants, RLS, function ownership and migration role. Revoke default `PUBLIC`, `anon` and `authenticated` table access to authorization records; apply RLS as defense in depth even in an unexposed schema. Any narrowly needed `SECURITY DEFINER` function must live outside exposed schemas, use a fixed `search_path`, explicit execute grants and current-identity checks, and receive independent review. A service-role or database password must never enter the browser or general public website path. Identify the dedicated server-side access mechanism and its blast radius before implementation.

## 2. Effective-permission decision — proposed

One server-side evaluator accepts `(authenticated principal/session, permission, resource, revision, environment, action)` and returns an audited allow/deny with a reason code. Use the stable permission names and publishing matrix in [ADR-020](adr-020-admin-platform-adm-00.md#proposed-authorization-contract).

1. Resolve a verified, non-anonymous, active Supabase Auth user and **live session**; reject absent, mismatched, revoked or expired sessions. Revalidate against the actual Auth behavior in a real-GoTrue test. A client role, `user_metadata`, menu visibility, stale JWT, `getSession()` result or `authenticated` database role never suffices.
2. Require `admin.enter` and TOTP-backed AAL2 at `/admin` entry. For critical actions, require separately verified fresh authentication no older than 15 minutes. Treat `iat` on a refreshed JWT as token issuance, **not** evidence of a new factor challenge. Bind freshness evidence to the current Auth session, account and action class; define expiry, replay handling and logout/revocation behavior in security review.
3. Load one active policy version, active assignments and individual grants from the private source. Union named permissions across roles and grants, then intersect scope, environment, start/expiry, suspension and action-specific constraints. Unknown state or unavailable source fails closed. `admin.enter` does not grant an action. `news.article.review` is not `news.article.approve_highlighted`.
4. Apply separation of duties after the union: no self-grant or self-approval of staff elevation, no highlighted approval by the revision's author/substantive editor (including Owner), no classification downgrade bypass. Editor and Administrator need explicit scoped `news.article.publish`; Owner may publish normal content. None of these can grant `production.deploy`, database/public-read publication or SQL/Cron/secret mutation.
5. Re-evaluate immediately before a side effect, in a transaction/serialization design that prevents a grant or revision swap between check and write. Define the linearization point for concurrent revoke/action: a revocation committed before the protected decision must deny; a later decision must see the revocation. Test simultaneous revoke, grant expiry, role change, policy activation and publish.

No long-lived permission snapshot in cookies or JWT claims is authoritative. A bounded cache is allowed only if its invalidation/version check proves the next-decision revocation rule; a no-cache first release is a viable simpler option. Denials and policy-source failures produce safe client errors and structured audit events without leaking staff state.

## 3. Supabase Auth, MFA and `/admin` session boundary — design gate

Supabase documents TOTP enrollment/challenge/verify and `aal2` session state; an AAL claim alone is not a fresh 15-minute proof. Validate the exact Auth endpoints, factor status, AAL transition and challenge timestamp against the version used by the project. Current references: [Supabase MFA](https://supabase.com/docs/guides/auth/auth-mfa), [TOTP](https://supabase.com/docs/guides/auth/auth-mfa/totp), [sessions](https://supabase.com/docs/guides/auth/sessions) and [JWT fields](https://supabase.com/docs/guides/auth/jwt-fields). No MFA route or allowlist change is part of ADM-01A.

The Account cookie is scoped to `/account`; `/admin` requires an explicit, reviewed same-origin session handoff or separate Admin session. **Candidate for review:** an authenticated, CSRF-protected Account POST issues a short-lived, single-use server-bound handoff; an Admin POST redeems it and creates a separate HttpOnly, Secure, `/admin`-scoped staff session tied to the same Auth user and `session_id`. The handoff cannot travel in a URL, log or public page. Every Admin decision still verifies the live Auth session and private permissions. Reject any design that widens the Account cookie to public routes, sends refresh tokens to browser JavaScript, creates a generic Auth proxy or trusts an Admin cookie as the sole authority. Security review must select the actual handoff/session storage, key management and fail-closed behavior.

**MFA decision still needed:** whether a critical step-up means a fresh password **and** TOTP challenge or a fresh TOTP challenge on an already authenticated AAL2 session; how to prove the challenge occurred within 15 minutes without mistaking token refresh for reauthentication; how to handle factor enrollment, multiple factors, lost factor and session invalidation. The selected flow must not alter Companion session independence or weaken the existing `/account` BFF and closed Auth request allowlist. Require rate limits, CSRF, generic errors and no secrets in logs for any new Auth calls.

## 4. Staff lifecycle, bootstrap and recovery — design gate

Normal assignment and direct grants need named proposer and approver authority, reason, scope, expiry, MFA step-up and immutable audit. Administrator/Owner assignment, elevated grants and grant ceilings need a reviewed two-person rule; subject and proposer cannot approve their own elevation. A staff suspension and grant revocation must be reflected at the next protected decision. Periodic access recertification should identify stale roles and grants.

The one-time initial Owner exception must target an owner-selected **existing verified account by exact Auth ID**. Design an operator-only, non-public ceremony with AAL2/freshness, atomic once-only state, evidence, post-run disablement and a staging rehearsal. A single Owner cannot independently approve the first Owner assignment; document the limited initial ceremony and out-of-band notification until two eligible approvers exist. Protect the last active Owner under concurrent revocations, suspensions and account deletion. Recovery must use a separate time-limited, independently reviewed break-glass procedure and leave a durable audit trail. **No first-Owner identity, bootstrap credential, recovery contact or operator path is approved here.**

## 5. Audit, privacy and trust boundaries — design gate

Record staff entry/step-up, authorization denials, policy activation, role/grant proposals/approvals/revocations/expiry, bootstrap/recovery, editorial approval and publish/unpublish/rollback, and moderation decisions. Include actor, subject, scope, reason, result, event time, request ID and relevant immutable revision/policy identifiers. Protect log integrity and read access; never include passwords, TOTP seeds/codes, access/refresh tokens, raw handoffs or private article payloads. Decide whether audit failures block critical writes or use a guaranteed transactional outbox; do not silently lose a successful privileged action's audit event.

The **owner-approved 365-day baseline** still needs privacy/security review of data minimization, retention start, purge proof, incident hold, backup copies, subject rights and access by auditors. Audit and staff records must never enter public article/RSS/sitemap output, the public read database, or Guildbook. Admin read-only operations views need separate approval and least-privilege sources; they do not grant operational mutation.

## 6. Proposed ADM-01B implementation sequence

These are future reviewable work packages, not authorization to implement them in this PR. Keep `release` and all production settings untouched until separate release approval.

1. Freeze the reviewed permission catalog, logical/physical schema and threat model; write pure evaluator tests first. Pin every proposed default beyond ADR-020 to an explicit security/product decision.
2. Prepare a separately reviewed, reversible **private** schema migration with least-privilege grants, RLS, policy version and grant lifecycle records, bootstrap guard and audit sink. Run preflight privilege checks and rollback rehearsal on disposable data before any environment application.
3. Add the reviewed `/account` → `/admin` session boundary and TOTP enrollment/verification flow through a closed server-side Auth client. Prove AAL2, live-session and 15-minute step-up semantics with real GoTrue before exposing staff routes.
4. Add one central decision API and protected action wrappers. Recheck immediately before side effects, then build staff assignment, revocation and one-time bootstrap/recovery behind the reviewed ceremonies. Keep all public CMS delivery out of ADM-01B.
5. Rehearse staff onboarding, revocation, factor loss, last-Owner protection, audit retention and rollback in staging. Require exact-HEAD CI, independent security review and a separate owner production GO before any real role assignment or activation.

## 7. ADM-01B negative security test contract

Run tests against real GoTrue plus disposable Postgres/PostgREST where the boundary requires it, with unit/property tests for pure permission evaluation. Mutate checks so each denial would fail if its guard were removed. At minimum prove:

- Default User, anonymous Auth user, Companion installation identity, deleted/banned user, missing or revoked session and forged `user_metadata`/JWT role cannot enter `/admin` or call its APIs.
- Two roles combine only named permissions; unknown policy, unavailable authorization store, wildcard, expired/not-yet-active/wrong-resource/wrong-environment grant and stale policy cache deny. Editor and Administrator cannot publish without their own scoped grant; a revoked grant denies on the next decision, including an open session.
- TOTP/AAL1, unverified factor, stale 15-minute evidence, token refresh masquerading as step-up, replayed handoff, cross-session handoff and logout/revocation fail closed. CSRF, rate limit and secret-leak checks cover new routes.
- Highlighted revision needs another eligible approver; Owner cannot self-approve; an Editor without the specific approval grant cannot approve. Revision change, classification downgrade, media swap and concurrent approve/publish or revoke/publish cannot reuse approval.
- Staff cannot approve their own elevation, exceed grant ceilings, assign Owner through a lower role or remove/suspend the last Owner. Bootstrap is once-only, exact-ID-bound and disabled afterward; recovery cannot become a standing bypass.
- Private authorization and audit tables reject `anon`/ordinary `authenticated` direct reads and writes; no service-role key reaches a bundle. Public article/feed/cache, public read database and Guildbook isolation remain intact. Critical writes either produce durable audit events or fail closed.

Keep existing Account and Companion acceptance suites green, including independent sessions and live-session guards. Require exact-HEAD CI, security review of SQL/RLS/function grants, a staging rehearsal and rollback plan before any production GO.

## 8. Unresolved decisions, approvals and ADM-01B readiness

| Gate | Required decision/evidence | Approver |
| --- | --- | --- |
| Authorization store | Schema location, logical-to-physical mapping, RLS/grants, policy-version activation, evaluator access path, cache/revocation and transaction model | Security and data owners |
| Admin session and MFA | `/account` → `/admin` handoff, TOTP endpoint/allowlist changes, AAL2 verification, exact 15-minute step-up evidence, factor loss and Companion independence | Security owner with Auth/account maintainer |
| Staff authority | Non-publishing matrix defaults, grant ceilings, protected assignments, two-person ceremony, recertification cadence | Product and security owners |
| Initial Owner/recovery | Exact first-Owner Auth ID, operator access, one-time bootstrap proof, last-Owner concurrency and approved recovery runbook | Product owner and security owner |
| Audit/privacy | 365-day baseline implementation, tamper evidence, failure behavior, retention exceptions, deletion/holds and audit-reader scope | Privacy and security owners |
| Editorial boundary | Substantive-edit and classification authority, immutable revision/approval interface; CMS storage and delivery remain ADM-03 | Product/editorial and security owners |

**ADM-01B readiness:** NOT YET READY FOR IMPLEMENTATION. Its scope may be planned now; a code or migration PR requires written decisions for the first five gates and acceptance of the negative-test/rollback plan. Its first implementation PR must remain isolated from ADM-03 content delivery and production privileges. No migration, privileged endpoint, role assignment or production activation is authorized by this plan.
