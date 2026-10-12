# Account System V1 — single-project pilot and production candidate

Status (2026-10-12): **CODE CANDIDATE ONLY**. No hosted activation, no database migration, no approval, no merge. Tracks [Issue #52](https://github.com/Imemoth/wow-foreverdb/issues/52). This supplements, but does **not** silently replace, the original isolated-staging runbook. The owner has chosen an alternative *single existing Supabase project* for the eventual pilot; security gates remain.

## 1. Unchanged isolation guarantees

- **ONE existing private Supabase project** hosts Companion ingest, Auth, installation ownership and private Guildbook. The account subsystem uses its **HTTPS Auth and allowlisted PostgREST RPC endpoints only** via server-side fetch, with a modern `sb_publishable_` key and the *user's JWT*. No service-role key, direct SQL connection, secret key, storage API or anonymous public table reads.
- Public search, data adapters, sitemap, publication and any `NEXT_PUBLIC_*` variable **must not** reference the private project. The existing `env.ts` public-read DB guard and static account-zone boundaries are unchanged. A future truly public release **still requires a separate, sanitized public read database**, which need not be a second Supabase project.
- Existing `public.installations.owner_user_id` remains authoritative. Migration 0012 is **NOT applied** by this PR. There were 7 existing installations owned by the same anonymous user in the preflight. Never test claim/redemption against those live installations before backup, Windows checks and explicit approval.

## 2. Four isolated Auth modes and approval controls

| Mode | Source approval flag | Platform/deployment | Auth origin | Public data |
| --- | --- | --- | --- | --- |
| disabled (default) | none | anywhere | none; no account routes | unchanged |
| local | none | developer machine only | loopback Supabase | fixture/local |
| staging | none | hosted Vercel **Preview** only | isolated non-private Supabase | synthetic preview |
| pilot | `SINGLE_PROJECT_PILOT_APPROVED = false` **must be reviewed/changed separately** | hosted Vercel **Preview** only, under Vercel Authentication | **exact existing private-project Auth origin**, separately corroborated by `ACCOUNT_AUTH_PROJECT_REF` | **synthetic preview only** |
| production | `PRODUCTION_ACCOUNT_AUTH_APPROVED = false` **must be reviewed/changed separately** | real `FOREVERDB_DEPLOYMENT=production` AND Vercel `VERCEL_ENV=production` | exact existing private-project Auth origin | **separate PUBLIC read DB only** |

The evaluator has a pure test-only injection point for the **post-approval policy**; the real runtime calls the evaluator with **two arguments** and uses the two compiled flags set to `false`. **No owner approval is derived from an environment variable.** Do not set `ACCOUNT_AUTH_MODE=pilot` or `production` until a separate reviewed change approves the specific mode. Merely merging this candidate must never enable accounts.

In both private-project modes: Auth URL must be a canonical HTTPS `<20-char-ref>.supabase.co` origin without credentials, path, query or port; ref must equal the existing private ref and the independently set `ACCOUNT_AUTH_PROJECT_REF`. Only well-formed modern publishable keys work. `ACCOUNT_CSRF_SECRET` must be at least 32 characters. Extra/unknown `ACCOUNT_AUTH_*` names fail closed. Bad combinations result in global environment validation failure, not a fallback to another project.

### Required Vercel environment *after* separate approval — DO NOT CONFIGURE NOW

- Pilot: `VERCEL_ENV=preview`, `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=fixture`. Protected preview hostname selected and frozen; Vercel Authentication remains ON, no public alias and no search indexing.
- Production: `VERCEL_ENV=production`, `FOREVERDB_DEPLOYMENT=production`, `FOREVERDB_DATA_SOURCE=postgres`, sanitized **PUBLIC** `PUBLIC_READ_DATABASE_URL`, `SITE_URL` matching Vercel production domain, full independent web go-live gates in `docs/web/go-live-checklist.md`.
- Account variables in the **selected** environment only: `ACCOUNT_AUTH_MODE`, `ACCOUNT_AUTH_URL`, `ACCOUNT_AUTH_PROJECT_REF`, `ACCOUNT_AUTH_PUBLISHABLE_KEY`, `ACCOUNT_CSRF_SECRET` (secret, not client-exposed). Keep them all **unset** while mode is disabled (stray fields fail closed).
- Every hosted account route already demands **Upstash** distributed throttling and **server-side Turnstile**. The pilot environment validator additionally requires `RATE_LIMIT_BACKEND=upstash`, `RATE_LIMIT_SALT`, `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `CHALLENGE_COOKIE_SECRET`. These protect website endpoints, **not direct GoTrue** calls.

## 3. Owner-only hosted acceptance *before a pilot flag can be flipped*

1. Review both Supabase Auth settings and applicable plan limitations. On the current Free plan the leaked-password protection feature requires Pro; this is an **unmet security criterion**, not a toggle we can assume exists. Record an explicit upgrade or risk decision before activation.
2. **Direct GoTrue abuse A24 remains OPEN**: anonymous client signup and refresh must continue working for Companion; project-wide CAPTCHA remains OFF. Set/read back Auth rate ceilings, mail daily cap, Resend bounce/spam alerts, named monitoring responder and a bounded abuse drill **on disposable/local infrastructure** first. Website Turnstile must not be counted as covering direct Auth.
3. SMTP transport has passed, but the first invite was classified as Spam by Gmail. SPF/DKIM PASS for `azerdex.com`; DMARC not yet evidenced. Validate branded Confirmation/Recovery **email templates** with `token_hash`, correct callback and delivered-to-Inbox evidence. The default `Send invitation` emails contain `type=invite&token` and a redirect; this is **NOT** the implemented website Confirmation flow (which expects `token_hash&type=email` or `type=recovery`). Do **not** test registration by clicking old invitation links.
4. Select the exact protected Preview origin *after* CI build is verified. Only then set Supabase Auth Site URL / exact Redirect URL allowlist and confirmation/recovery templates. **Never leave localhost or broad wildcard URLs in production.** Do not set Site URL to the currently protected synthetic production alias until its production releases are approved.
5. Obtain an owner-approved backup, record installation/owner and Auth-user baselines and inspect migration 0012's preflight, ledger and rollback runbook. Test 0012 in a disposable equivalent database; **do not run 0010** (reserved), **do not run 0013** (recovery only), and do not apply 0012 to private production until an additional explicit owner approval. Production `0012` should be an ordered, separately approved migration with read-back.
6. Complete hosted gateway PostgREST transaction-mode, grants, rate-limit and Auth JWT version checks from `docs/account-v1/staging-runbook.md`. Without an isolated staging Supabase, mark **HOSTED SINGLE-PROJECT PILOT VERIFIED** only with *actual* evidence; never mislabel it STAGING VERIFIED.
7. Account end-to-end against throwaway **registered** A/B users and an explicitly disposable installation; registered vs anonymous checks; GET confirmation no side effect; CSRF, replay/concurrency, pre-hijack, reset global signout, separate web/Companion session, ownership isolation and private Guildbook denial. Do not transfer any existing owner installation for the first pilot. Run Windows W1a/W1b–W10 acceptance and preserve existing Companion anonymous identity.
8. Document kill-switch rehearsal: unset all account vars and set `ACCOUNT_AUTH_MODE=disabled` in the targeted environment (deploy once; no fallback) + if migration 0012 exists use the **non-destructive** account RPC kill-switch script. Do not use full rollback on a database with claim/ownership history. Preserve `release`, existing protected synthetic production alias, and public web availability.
9. Obtain written owner **pilot** approval (specific commit + deployment + protections + time) before changing the pilot source flag; obtain a **separate** written production approval before the production flag and release promotion.

## 4. Verification and evidence

From `web/` on Node 24 after `npm ci`: `npm run typecheck`, `npm run lint`, `npm test -- --run tests/unit/account-config.test.ts` (or `npx vitest run tests/unit/account-config.test.ts`), full `npm test`, `npm run build` and bundle-secret scanner as applicable. The GitHub Actions Account GoTrue/PostgREST, Web/CI and CodeQL workflows must be green on the **final PR head**. Successful CI alone is *not* hosted acceptance.

Evidence at creation: candidate source/test/doc change only; **pilot flag OFF, production flag OFF, migrations untouched, Supabase unchanged, Vercel unchanged, release unchanged, no account activated**.

Related: [security](security.md), [original staging runbook](staging-runbook.md), [integration evidence](integration-and-acceptance-report.md), [migration/rollback](0012-deployment-and-recovery.md), [public web go-live](../web/go-live-checklist.md).
