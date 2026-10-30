# AzerDex GDPR, consent and privacy readiness

Controller: **Hrabovszki Péter**, a private individual. AzerDex is an independent, free, non-commercial fan project.
Privacy contact: `privacy@azerdex.com` (dedicated Resend Inbox). Supervisory authority: NAIH (Hungary).
Notice version in code: `PRIVACY_NOTICE_VERSION` in `web/src/lib/consent.ts` (bumping it withdraws every stored analytics choice and asks again).

Status of this work: a **stacked Draft PR** onto the RC branch `release-rc/azerdex-beta-20261030`. Nothing here was merged, deployed, scheduled or run
against any production resource. The release boundary (PR #141 stays Draft; no `release`/`main` change; no Vercel promotion) is untouched.

| Document | What it is |
| --- | --- |
| [dsar-runbook.md](dsar-runbook.md) | Manual procedure for access / correction / deletion / restriction / objection / portability requests received at the privacy inbox |
| [incident-response-runbook.md](incident-response-runbook.md) | Personal-data breach response, evidence handling, the 72-hour assessment, admin-access review checklist |
| [processor-inventory.md](processor-inventory.md) | Who processes what, where, under which DPA / transfer mechanism, with a verification checklist |
| [retention-schedule.md](retention-schedule.md) | Every personal-data store, its retention rule, whether anything enforces it, and the prepared cleanup |
| [companion-data-flow-audit.md](companion-data-flow-audit.md) | What the addon and Companion actually collect and upload (basis of the notice's separate section) |

Related code: consent (`web/src/lib/consent.ts`, `web/src/components/consent/`), notice (`web/src/components/PrivacyContent.tsx`),
account-page notices (`web/src/app/account/_ui/PrivacyNote.tsx`), retention scripts (`database/ops/retention_cleanup_*.sql`, tests in
`database/tests/account/10_retention_cleanup.test.mjs`).

## Release blockers (need an owner decision before any production release containing the Companion)

1. **The Companion uploads the Guildbook (guild roster with other players' character names) to the private backend** in this RC. The
   "Guildbook Companion-local only" change (PR #112) was merged into `feature/account-independent-collector-credentials`, **not** into this RC or `release`.
   Only the *hosted website* is Guildbook-free today. Decide: (a) land the local-only change (and the notice section then needs updating; a
   test in `web/tests/unit/companion-disclosure.test.ts` fails the moment the upload code is removed, to force that), or (b) keep the upload and accept the
   disclosure now in the notice, including a documented legitimate-interests assessment for the third-party names. Several public pages still say the Companion
   sends only "aggregated counters" (see the audit doc, section 5); they contradict the code and the new notice.
2. **No erasure path exists in the product.** Deleting an `auth.users` row does **not** remove installation, device, claim or audit data (no FK to `auth.users`,
   and `account_installations` / `devices` are `ON DELETE RESTRICT`). The runbook gives a manual, ordered, reviewed procedure; it has not been rehearsed
   on a real project.
3. **Retention rules exist in code but nothing enforces most of them** (only `azerdex-welcome-prune` is scheduled). The notice says so honestly. The prepared cleanup
   (`database/ops/retention_cleanup_*.sql`) needs a separate authorization to install and schedule.
4. **Cloudflare DPA applicability** on the account in use must be confirmed (its DPA is not shown to apply automatically to self-serve plans).

## Owner decisions still open

- Retention periods for data that has none (device registry and its audit trail, `map_asset_diagnostics`, idle installations and their Guildbook, anonymous auth users, privacy-inbox correspondence). None was invented.
- Re-ask interval for the consent choice (it currently only re-asks when the notice version changes; the date is stored, so an expiry is trivial to add).
- Whether to publish a postal address (not published; email is the contact).
- Legitimate-interests assessment for third-party character names in Guildbook uploads (if the upload stays).
- Whether the email templates and the welcome email should carry a privacy link (templates live in `docs/azerdex-auth-email/` and are published to Resend; changing them is an owner action).
- Whether to correct the public pages that describe the Companion as sending only aggregated counters.
- Supabase backup retention (plan-dependent) to state in the runbook; Resend retention of sent-mail logs.
- Admin MFA / least-privilege confirmation for Vercel, Supabase, Resend (inbox), Cloudflare, GitHub (checklist in the incident runbook; not verifiable from the repo).
- Update `docs/account-v1/README.md` (stale: still says production account auth is blocked).
