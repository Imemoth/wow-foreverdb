# azerdex-welcome-worker (Supabase Edge Function)

Sends the one-time AzerDex welcome e-mail from the private outbox (migration 0015). **Not deployed by this repository.** See
`docs/azerdex-welcome-email/runbook.md`.

Files: `index.ts` (HTTP entry, secret check) · `worker.ts` (bounded run loop, circuit breaker) · `resend.ts` (outcome taxonomy) ·
`email.ts` (payload: rendered HTML + text, or hosted template) · `logo.ts` (CID emblem validation) · `logo-data.ts` (generated embedded emblem) · `db.ts` (the two named RPCs) ·
`config.ts` (flags and fixed sender settings).

**Emblem (G-1, embedded):** `azerdex-logo.png` (128×128, 6,819 B) is the reviewed source; `logo-data.ts` is **generated** from it (`node scripts/embed-azerdex-logo.mjs`, `--check` in tests) and imported by `index.ts`, so every deploy path bundles it (Supabase cannot ship static files with API-based deploys). The worker validates the PNG (signature, 128×128, size cap, every chunk CRC, IEND last, no trailing bytes) before every run and sends nothing otherwise (`logo_invalid`).

Secrets (Supabase Edge Function secrets only): `AZERDEX_WELCOME_ENABLED` (exact `true` to send), `AZERDEX_WORKER_SECRET` (≥ 32 chars),
`RESEND_API_KEY` (sending-only key restricted to the domain), `AZERDEX_WORKER_DB_KEY` (server key; falls back to the platform's
`SUPABASE_SERVICE_ROLE_KEY`), optional `AZERDEX_WELCOME_MODE` (`html` code default | `template` recommended once staging passes; any other value = `html`), `AZERDEX_WELCOME_MAX_PER_RUN` (1–10; 0, negative or unparsable = 1).
`SUPABASE_URL` is provided by the platform. Never put any of these in Vercel, the web app, Companion, addon or git.

Tests: `node --test tests/welcome-worker/*.test.mjs` (Node 22.18+/24 type stripping). `worker.test.mjs` needs no Deno; `asset-and-deno.test.mjs` runs the real Deno entry point against a staged graph-only bundle with no file-read permission and needs `deno` (`DENO_BIN`, `FDB_REQUIRE_DENO=1` makes a missing Deno a failure instead of a skip).

## Emblem provenance (`azerdex-logo.png`)

Source: owner-supplied brand kit `AzerDex-Icon-128.png` (128×128 RGBA, 31,161 B, sha256 `9a162424…fe9c`). Optimised for e-mail by palette quantisation
(256 colours, alpha preserved, no dithering, PNG `optimize`) to **6,819 B** (sha256 in `azerdex-logo.sha256`; pinned by `tests/welcome-worker/asset-and-deno.test.mjs`).
Composited over the body colour `#0D0F33` the PSNR against the source is 35.4 dB (halo slightly tighter; emblem detail intact). The brand kit's own README
suggests an HTTPS-hosted 512 px image; this project deliberately does **not**: the image is attached inline (CID) so nothing is fetched from a third-party host.
Replacing the file requires updating `azerdex-logo.sha256` **and** re-running `node scripts/embed-azerdex-logo.mjs` in the same commit (a conscious, reviewed change; tests fail otherwise).
