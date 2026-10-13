# AzerDex Welcome Email V1 — secure outbox and onboarding design

**Date:** 2026-10-13
**Status:** DESIGN FOR OWNER REVIEW; not implementation approval or authorization to deploy.
**Scope:** first verified registered-account welcome email using the existing Resend `azerdex-welcome-v1` template, with the 128 px CID logo. Account/Companion pilots remain OFF.

## 1. Intent and user contract

Once a person finishes **their first genuine registration e-mail verification**, AzerDex should send one short, useful welcome message within a few minutes. The user can sign in immediately; delivery failures, outages, repeated confirmation clicks, and slow providers must not break registration or delay the account UI. The account screen must not falsely claim that an email was delivered. The welcome is transactional onboarding, **not** consent for marketing/newsletters.

Keep **Dark Arcane Fantasy** as the canonical design: #07091C outer background, #0D0F33 body, #191A47 detail panels, #6C41C7 primary CTA, #D9B978 gold, high-contrast text, plain-text alternative, accessible image alt text and an always-visible support address. Do not try to force a theme against Gmail's own dark-mode conversion. The CTA goes to `https://azerdex.com/` only once the destination is publicly accessible and useful (current protected demonstration site is NOT such a destination). No password, token, session ID, installation identifier, confirmation token or tracking identifier belongs in the welcome message or URL. Keep `Reply-To: support@azerdex.com`.

Verified recipient: the **current, confirmed** account email, rechecked at the moment of dispatch. Never send to a deleted, anonymous, disabled, unverified, changed-address or wrong-account identity. Historical accounts should not receive bulk backfill merely because this feature is installed.

## 2. Selected architecture and alternatives

**Selected:** a durable, private PostgreSQL outbox in the existing Supabase project; a database-generated account verification event; and a separately authenticated Supabase Edge Function worker triggered by Supabase Cron (`pg_cron` + `pg_net`). The worker uses the existing published Resend template and attaches the CID emblem for each send. The website and Windows Companion **do not receive** a Resend token, privileged Supabase key or private-database connection.

Rejected for V1:

- Direct send inside `/account/api/confirm`: network failures could affect verification; browser retries and recovery-token ambiguities can trigger duplicate or wrong-flow mails.
- Public HTTP webhook directly from the Auth trigger: no durable queue, additional attack surface and availability coupling.
- A second Vercel database or general service-role API proxy: unnecessary cost and expanded credentials surface for a welcome-only use case.

## 3. Trusted event, eligibility and deduplication

1. A migration creates `private.azerdex_welcome_candidates` (trusted eligibility metadata for new email/password registration) and `private.azerdex_welcome_outbox` (unique **one row per account user ID**), in a schema that is **not exposed through PostgREST**. Both tables have RLS enabled with no `anon`/`authenticated` policies, and all `PUBLIC`, `anon` and `authenticated` table/function grants are revoked. A registered account JWT alone must not read, enqueue or edit these records. Explicitly test anonymous Supabase JWTs, since they use the `authenticated` database role.
2. A minimal, fully qualified, reviewed `SECURITY DEFINER SET search_path = ''` trigger on `auth.users` records eligible **new** non-anonymous email/password registrations after a separately recorded activation timestamp; a second trigger detects a genuine first change of `email_confirmed_at` from NULL to non-NULL. Only this state transition may request outbox insertion, and the unique `user_id` constraint collapses duplicates. Do not infer confirmation from `confirmed_at` (which may denote phone verification), `user_metadata`, client-supplied `type`, redirect query strings, the public web account session, or a second login.
3. **Recovery ambiguity is a release blocker:** before activation, prove on the pinned real GoTrue build that recovery/password-reset tokens cannot accidentally cause a welcome for an otherwise unverified signup. If they can, add a trustworthy server-side signup-verification provenance signal or keep welcome sending OFF; do not simply trust a `type=signup` request field. Ordinary password resets and email-change confirmations must never generate another welcome event.
4. Trigger handlers do **no network I/O** and execute only constant-time local SQL with a bounded timeout. They must not intentionally fail sign-up/sign-in: catch narrowly classified operational exceptions, log only generic identifiers, and let GoTrue succeed. Because suppressing a trigger error might lose an outbox event, a tightly bounded **reconciler** checks eligible accounts created after the activation timestamp for missing work; no historical wide scan or unsolicited backfill. Missing-event counters must surface in diagnostics.
5. Outbox record fields: `user_id` (PK), verified recipient as temporary PII, `event_at`, `status` (`pending`, `leased`, `sent`, `retry`, `suppressed`, `review_required`), `attempts`, `next_attempt_at`, `lease_until`, provider email ID, and an allowlisted machine error code. Do not store access tokens, raw HTML, CID bytes, passwords or raw HTTP failure bodies. Deleting an Auth user must suppress queued work and remove stored personal data without breaking auth deletion. Keep a minimal user-ID sent tombstone until deletion so cleanup does not re-enable duplicates; redact/remove recipient and provider metadata on a bounded retention schedule.

## 4. Isolated worker and sending contract

- Supabase Cron invokes a dedicated Edge Function on a conservative interval (initially every minute, at most 10 jobs/run). Use a **named secret credential** held in Supabase Vault for the scheduler; the function must require authentication for exactly that named secret (`auth: 'secret:<name>'`, with the corresponding `verify_jwt` deployment setting, reviewed against the current SDK). Never use `auth: 'none'`, expose its invocation secret to the browser or create any general-purpose admin proxy.
- The function uses project-side privileged DB access **only inside this isolated worker**, through named, audited, bounded RPC operations to claim and finalize jobs. The worker credential can bypass RLS and is high impact; use the narrowest supported credential, scope its outbound behaviour in code, store it in Supabase secrets, and never place it in Vercel, browser, addon, Companion, GitHub files or logs. Public-schema RPC wrappers (if needed because `private` is not exposed through PostgREST) must grant `EXECUTE` only to a trusted server role, pin `search_path`, enforce input/output shape and never accept user-supplied recipient addresses. A separate dedicated database role is preferable if feasibility testing shows reliable direct database access.
- Atomic claiming uses `FOR UPDATE SKIP LOCKED`, a short lease, a unique `user_id` and a guarded final state change. A worker must re-check the Auth identity and its current confirmed email before sending; deletion, loss of verification, account mismatch or address change causes safe suppression. Hard cap sends globally and per run, with circuit-breaker on widespread failures.
- Request Resend template **`azerdex-welcome-v1`** (currently published) and stable variable `CTA_URL`, From `AzerDex <welcome@azerdex.com>`, Reply-To `support@azerdex.com`. Attach the bundled **128x128 PNG (~3.3 KB)** on *each* send as `contentId: 'azerdex-logo'`, matching the template's `<img src="cid:azerdex-logo">`. No external logo URL. Render a useful text part and fallback alt text. **A standalone CID HTML email was tested; the combination of hosted Resend template + CID attachment has not yet been separately proven.** This exact combination needs a real provider test before release; if unsupported, use a version-controlled rendered HTML body and attachment without losing the reviewed design.
- Resend acceptance is not delivery. Persist the provider ID on accepted send; record delivery/bounce via verified provider event/webhook only when implemented, otherwise report `accepted` distinctly from `delivered`. No open/click tracking, marketing tagging or undisclosed analytics for V1.
- Retry 429/5xx and transport timeouts with bounded exponential backoff; do not retry nonretryable 4xx, bounce or suppression. Use a deterministic, event-specific Resend Idempotency-Key. Because Resend's idempotency window is finite and a transport timeout can mean **unknown send outcome**, automatic retries past that window must STOP as `review_required` for operator reconciliation. Do not claim perfect 'exactly once delivery': guarantee one durable enqueue per user and use controlled deduplication plus manual resolution of ambiguous sends.

## 5. UX and accessibility

- Confirmation UX: success response and redirect do not await the worker; account access remains available even when Resend is down. Never show 'welcome e-mail sent' until the backend has evidence. A short, accurate account confirmation message is enough.
- Welcome arrives typically within a few minutes; if delayed the user takes no action. The email is not a second authentication step. Primary CTA clearly says **Explore AzerDex** and must point to a functioning landing page, never to a Vercel SSO/protected preview or a claim/device-activation endpoint.
- English V1 copy matches the current template; reply goes to working support inbox. No implied affiliation with Blizzard. For narrow phone widths and Gmail desktop/iPhone, verify readable dark and client-converted light variants, clipping, CTA touch target, CID fallback and visible footer text. HTML images blocked should leave the wordmark readable as text.

## 6. Release separation and safety gates

- Separate docs/design and eventual implementation PR from `main`; **do not modify #56**, its migrations, its deployment flags or its account/Companion logic. Current stacked chain is **#53 → #54 → #55 → #56**; all are draft. Do not merge any branch with pilot approvals ON.
- Current migration IDs: `0012` is the approved ownership dependency already reported applied to the private project; `0014` is reserved for #56 zero-touch device enrollment and is **NOT** applied; `0010` is reserved. The welcome migration should allocate the next unoccupied post-0014 ID (normally `0015`) **only after confirming branch/ledger order**. No production SQL, Edge Function, Cron or secrets are installed merely by approving this spec.
- `AZERDEX_WELCOME_ENABLED` is a dedicated **worker-side**, fail-closed switch, default OFF; do not alter `PRODUCTION_ACCOUNT_AUTH_APPROVED`, `SINGLE_PROJECT_PILOT_APPROVED`, the Companion approvals, account gate modes or DNS. Rollout requires two explicit approvals: backend infrastructure rollout and then first real recipient send. Kill switch must disable enqueue/dispatch quickly while preserving the outbox records.
- Local first: disposable PostgreSQL 16 + real pinned GoTrue and mocked Resend; never test account creation, secret scope or schema mutations against the single live private Supabase project. Hosted stage requires a separate owner-approved isolated project or an equivalently isolated non-production environment. No public release until browser, provider and abuse acceptance passes.
- Existing `azerdex.com` is connected to the Vercel project, but deployment protection may block access; validate the CTA before sending to any actual new registrant. Account/Companion feature gates must not be bypassed by this email subsystem.

## 7. Acceptance and threat-model test matrix

**Functional:** fresh eligible signup → initial email confirmation → one outbox event → one provider-accepted welcome; repeat confirmation, repeated login and two simultaneous workers → no second mail; verified account recovery/password reset → no event; unverified-account recovery ambiguous path → reject deployment until resolved; anonymous JWT signup/Companion auth → no welcome; account email change/deletion before send → suppress; old accounts before feature enable → no email; flow still succeeds when Resend, Cron or worker is offline.

**Security:** revoked direct access from `anon` and authenticated roles, public schema RPC enumeration, arbitrary recipient/SSRFI attempts, unauthorized Edge invocation and stolen named key rotation, 2+ workers and expiry/retry concurrency, long network timeout, idempotency expiry, malformed provider response, SQL trigger exception, events after disable, no raw recipient or secrets in public logs and no external CID image URL. Review `SECURITY DEFINER`, schema search paths, role grants, PostgREST exposure, RLS independently.

**Visual/client:** exact **template + CID attachment** provider test; Gmail desktop, iPhone Gmail and Outlook sample where practical; consistent Dark Arcane visual identity, legible client light-mode transformation, meaningful alt text, no horizontal overflow or clipping, functional CTA, text fallback, support Reply-To and no promotional consent bypass.

**Evidence levels are distinct:** code present ≠ unit tests pass ≠ real GoTrue/Resend success ≠ hosted staging pass ≠ Windows/Companion acceptance ≠ production approval. Keep a reviewer-visible checklist and redacted run evidence.

## 8. Observability, operations, and rollback

- Track counters for eligible confirmations, successful enqueues, missed/reconciled enqueues, pending age, provider accepted, rate-limited, suppressed, hard failures, unknown outcomes and `review_required` records. Alert for stale pending jobs (>10 minutes), repeated 429/5xx or failed triggers, without including raw personal data in alert contents.
- Kill switch disables the Cron dispatch and new event enqueueing without changing account validity. The data structures remain for review/retry. Document migration rollback and forward-only restore with ledger-safe records. No automatic deletion of history that would permit duplicate welcomes; GDPR erasure removes personal data on account deletion.
- Operator can review a redacted job and intentionally retry unknown sends after checking the provider's history. Do not build a public resend button or new customer-facing admin UI for V1. Avoid auto-responders on support inbox.

## 9. References and owner review

- [Account V1 integration chain and pilot-flag gate](../../account-v1/integration-and-release-order.md)
- [Account confirmation route](../../../web/src/app/account/api/confirm/route.ts)
- [Supabase Auth user state](https://supabase.com/docs/guides/auth/users)
- [Supabase trigger precautions](https://supabase.com/docs/guides/auth/managing-user-data)
- [Supabase scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase Edge Function authorization](https://supabase.com/docs/guides/functions/auth)
- [Resend inline CID](https://resend.com/changelog/embed-images-using-cid)

**Decision requested after reviewing this document:** approve the scoped worker/outbox design and its explicit recovery/unknown-send release gates. Only then produce the implementation plan; do not interpret this specification as permission to change production.
