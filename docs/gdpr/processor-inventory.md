# Data-processing inventory and processor / DPA checklist

Based on the code at the RC baseline plus this PR. Env values were not read; what is *enabled* on beta/production is taken from `docs/web/*` and must be confirmed by the owner. Regions: both Supabase projects are `eu-west-1` per `docs/web/00-current-state-assessment.md` and `docs/web/public-beta-release.md` (confirm in the dashboard before relying on it).

## Inventory

| Processor | Personal data | Where in the code | Role | Notes |
| --- | --- | --- | --- | --- |
| **Vercel** (hosting) | IP address and request data for every page; **Web Analytics only after opt-in** (page path, referrer, approx. location, browser/device; 24 h hashed visitor) | platform; `web/src/lib/analytics.ts`, `web/src/components/consent/` | processor | Speed Insights is OFF unless `AZERDEX_SPEED_INSIGHTS=1`, and when on also needs the opt-in. `proxy.ts` reads the client IP only to hash it. No `vercel.json`/region pinning found. |
| **Supabase, private project** | account email, password (Auth), sessions/refresh tokens, installation ids, claims, enrollment tickets, device records (**computer name label**), audit rows, installation statistics, **historical Guildbook rosters uploaded by earlier Companion versions (third-party character names; no longer written)**, map diagnostics, welcome-queue (SHA-256 of email) | `web/src/lib/account/*` (server), Companion directly, `database/migrations/*` | processor | Companion talks to Supabase directly, so Supabase sees the user's IP. Edge Functions (`azerdex-auth-email`, `azerdex-auth-confirm`, `azerdex-welcome-worker`, `publish-observations`, news collector) run here. pg_cron/pg_net/Vault: schedules and secrets. |
| **Supabase, public project** | aggregates only (no personal data by design) | `AZERDEX_READ_DB_URL` | processor | Read model; no installation/account/guild columns. |
| **Resend** | recipient email, message body incl. confirm/reset links; **the privacy inbox correspondence** | `supabase/functions/azerdex-auth-email`, `azerdex-welcome-worker` | processor | **Primary processing in the United States** (DPA §6.1). Retains its own sent-mail copy; DPA: customer data deleted within 90 days of *account termination*. |
| **Cloudflare Turnstile** | challenge data; `remoteip` for `/verify` | `components/TurnstileWidget.tsx`, `lib/account/turnstile.ts`, `api/v1/challenge/route.ts` | processor | CSP allows `challenges.cloudflare.com` only when a site key is set. Account Turnstile verification does not forward the IP; `/verify` does. |
| **Cloudflare Pages (asset CDN)** `azerdex-assets.pages.dev` / `assets.azerdex.com` | ordinary request data (IP, UA, referrer) | `lib/maps/*`, `lib/talents/icons.ts` | processor | Only while the zone-map / hero / icon CDN flags are on (docs say on for beta). Was **missing from the notice**; now listed. |
| **Upstash Redis** | rate-limit counters: keyed IP hash, **raw random `fdb_sid` value**, keyed email/user hash | `lib/security/rate-limit.ts`, `lib/account/limits.ts` | processor | Only when `RATE_LIMIT_BACKEND=upstash` (docs say beta). Counters expire (2× window). Was **missing from the notice**; now listed. |
| **GitHub** | none unless a link is followed; source, CI | footer/download links | - | Plain links. |
| **Buy Me a Coffee** | none unless the link is followed | `lib/support-link.ts` | independent controller | Plain link, nothing loaded. |
| **wago.tools, Blizzard CDN** | IP of the user's PC, from the **Companion** | `companion/.../AutoAtlasBuildVerifier.cs` (wago), CascLib (Blizzard, inferred) | independent third parties, contacted by the user's own software | Disclosed in the notice's Companion section. |

Logs: `proxy.ts` writes `{at,event,rule,reason,client: <first 8 hex of keyed IP hash>}` on rate limiting (disclosed); `lib/account/http.ts` logs route/status/code only; Edge Functions log counts and codes. No email, token or raw IP is logged. If `RATE_LIMIT_SALT` is unset a public dev salt is used (production requires it, `lib/env.ts`).

## DPA and transfer checklist (verified against the providers' pages on 2026-10-30)

| Provider | DPA | Transfer mechanism in the DPA | How it becomes binding | Owner action |
| --- | --- | --- | --- | --- |
| Vercel | https://vercel.com/legal/dpa | 2021 EU SCCs (Sched. 3 §3; Modules 1-3), UK/Swiss addenda. DPF not mentioned in the DPA | automatically on accepting the Agreement; SCCs deemed signed | download the executed copy for the records; subscribe to sub-processor changes (privacy@vercel.com / security.vercel.com) |
| Supabase | https://supabase.com/legal/dpa | 2021 EU SCCs (Modules 2, 3; Irish law); UK/Swiss addenda. DPF not mentioned | automatically with the Terms (clause 12.2) | confirm region = eu-west-1 on both projects; record **backup retention** for the plan; region commitment is conditional ("primarily"), see the DPA |
| Resend | https://resend.com/legal/dpa | EU SCCs (§6.2), UK and Swiss; **processing primarily in the US** (§6.1) | on accepting Terms / executing the DPA; executed copy in the dashboard | download the executed DPA; note 90-day post-termination deletion; keep the inbox access to the owner only |
| Cloudflare | https://www.cloudflare.com/cloudflare-customer-dpa/ | EU SCCs (Modules 2/3) **and** Cloudflare states DPF compliance (§6.4) | **not shown to apply automatically to self-serve plans** — "from the date Customer signed or the parties otherwise agreed" | **confirm the DPA is in force on the account in use (sign it in the dashboard if not).** Release blocker until confirmed |
| Upstash | https://upstash.com/trust/dpa.pdf (copies of different dates exist; check the current one) | European Annex applies when GDPR applies; transfer text not confirmed from the web search | not confirmed | confirm DPA acceptance and the **database region** (EU region exists per third-party sources; verify in the console) or drop to the in-memory backend if not needed |

Notice wording (in `PrivacyContent.tsx`) therefore says only: processing "under the providers' data-processing terms", SCCs "where applicable", Resend stores in the US, and links the DPAs. Do not strengthen it (e.g. "all data stays in the EU") without the owner confirmations above.

## Operational security notes

- Secrets live only in provider consoles / Supabase Vault / Vercel env; `web` runs `check:bundle-secrets`. The Companion contains only the Supabase **publishable** key.
- All private tables are RLS-enabled with every privilege revoked from API roles; access is through SECURITY DEFINER RPCs (verified by existing SQL suites).
- Admin MFA and least privilege: see the checklist in [incident-response-runbook.md](incident-response-runbook.md); not verifiable from the repository.
