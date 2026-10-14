# azerdex-welcome-worker (Supabase Edge Function)

Sends the one-time AzerDex welcome e-mail from the private outbox (migration 0015). **Not deployed by this repository.** See
`docs/azerdex-welcome-email/runbook.md`.

Files: `index.ts` (HTTP entry, secret check) · `worker.ts` (bounded run loop, circuit breaker) · `resend.ts` (outcome taxonomy) ·
`email.ts` (payload: rendered HTML + text, or hosted template) · `logo.ts` (CID emblem validation) · `db.ts` (the two named RPCs) ·
`config.ts` (flags and fixed sender settings).

**Emblem asset (committed):** `azerdex-logo.png` next to `index.ts`: the existing AzerDex rune emblem,
PNG, exactly 128×128, ≤ 16 KB; `supabase/config.toml` lists it under `static_files` so the deployment bundles it (**verify with the staging smoke test: a missing/unbundled file shows as `logo_invalid`**). Without it the worker refuses to run (`logo_invalid`) and sends nothing.

Secrets (Supabase Edge Function secrets only): `AZERDEX_WELCOME_ENABLED` (exact `true` to send), `AZERDEX_WORKER_SECRET` (≥ 32 chars),
`RESEND_API_KEY` (sending-only key restricted to the domain), `AZERDEX_WORKER_DB_KEY` (server key; falls back to the platform's
`SUPABASE_SERVICE_ROLE_KEY`), optional `AZERDEX_WELCOME_MODE` (`html` default | `template`), `AZERDEX_WELCOME_MAX_PER_RUN` (1–10; 0, negative or unparsable = 1).
`SUPABASE_URL` is provided by the platform. Never put any of these in Vercel, the web app, Companion, addon or git.

Tests: `node --test tests/welcome-worker/worker.test.mjs` (Node 22.18+/24, type stripping; no Deno needed).

## Emblem provenance (`azerdex-logo.png`)

Source: owner-supplied brand kit `AzerDex-Icon-128.png` (128×128 RGBA, 31,161 B, sha256 `9a162424…fe9c`). Optimised for e-mail by palette quantisation
(256 colours, alpha preserved, no dithering, PNG `optimize`) to **6,819 B** (sha256 in `azerdex-logo.sha256`; pinned by `tests/welcome-worker/asset-and-deno.test.mjs`).
Composited over the body colour `#0D0F33` the PSNR against the source is 35.4 dB (halo slightly tighter; emblem detail intact). The brand kit's own README
suggests an HTTPS-hosted 512 px image; this project deliberately does **not**: the image is attached inline (CID) so nothing is fetched from a third-party host.
Replacing the file requires updating `azerdex-logo.sha256` in the same commit (a conscious, reviewed change).
