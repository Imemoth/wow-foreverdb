# azerdex-welcome-worker (Supabase Edge Function)

Sends the one-time AzerDex welcome e-mail from the private outbox (migration 0015). **Not deployed by this repository.** See
`docs/azerdex-welcome-email/runbook.md`.

Files: `index.ts` (HTTP entry, secret check) · `worker.ts` (bounded run loop, circuit breaker) · `resend.ts` (outcome taxonomy) ·
`email.ts` (payload: rendered HTML + text, or hosted template) · `logo.ts` (CID emblem validation) · `db.ts` (the two named RPCs) ·
`config.ts` (flags and fixed sender settings).

**Required asset (owner supplies, not in git history yet):** `azerdex-logo.png` next to `index.ts`: the existing AzerDex rune emblem,
PNG, exactly 128×128, ≤ 16 KB. Without it the worker refuses to run (`logo_invalid`) and sends nothing.

Secrets (Supabase Edge Function secrets only): `AZERDEX_WELCOME_ENABLED` (exact `true` to send), `AZERDEX_WORKER_SECRET` (≥ 32 chars),
`RESEND_API_KEY` (sending-only key restricted to the domain), `AZERDEX_WORKER_DB_KEY` (server key; falls back to the platform's
`SUPABASE_SERVICE_ROLE_KEY`), optional `AZERDEX_WELCOME_MODE` (`html` default | `template`), `AZERDEX_WELCOME_MAX_PER_RUN` (≤ 10).
`SUPABASE_URL` is provided by the platform. Never put any of these in Vercel, the web app, Companion, addon or git.

Tests: `node --test tests/welcome-worker/worker.test.mjs` (Node 22.18+/24, type stripping; no Deno needed).
