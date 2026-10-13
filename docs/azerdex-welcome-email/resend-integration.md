# Resend integration

## Message

| Field | Value (fixed in `config.ts`, not settable by request, database row or secret) |
| --- | --- |
| From | `AzerDex <welcome@azerdex.com>` |
| Reply-To | `support@azerdex.com` |
| Subject | `Welcome to AzerDex — Know Your World` |
| CTA | **Explore AzerDex** → `https://azerdex.com/` (**release blocker B-1 until publicly reachable**) |
| Language / design | English; Dark Arcane Fantasy: `#07091C` outer, `#0D0F33` body, `#191A47` panels, `#6C41C7` CTA, `#D9B978` gold. No `prefers-color-scheme: light` override; clients may convert colours themselves. |
| Emblem | `<img src="cid:azerdex-logo" alt="AzerDex rune emblem">` + attachment `{filename: azerdex-logo.png, content_type: image/png, content_id: "azerdex-logo"}` on **every** send. No external image URL anywhere (asserted). |
| Plain text | always sent (html mode); accessible alt text; visible support address; button fallback URL line |
| Content rules | no password, code, token, installation ID, session ID or tracking parameter; says AzerDex never asks for credentials by e-mail; transactional, not marketing |
| Tracking | the API has no per-message open/click switch: **domain-level open and click tracking for `azerdex.com` must be OFF in the Resend dashboard (gate G-5)**. The payload contains no tracking tags. |

## Template + CID: unproven → two modes

The task required testing the **published template `azerdex-welcome-v1` together with a CID attachment** in one send. That needs a real Resend API key and a
real send; none was available or permitted here, and the public reference documents `template: {id, variables}` as exclusive with `html`/`text`/`react` but shows no
`content_id` attachment example. So it is **not claimed**:

* `AZERDEX_WELCOME_MODE=html` (**default**): version-controlled rendered HTML + text (`email.ts`) with the CID attachment — the combination the earlier standalone test proved.
* `AZERDEX_WELCOME_MODE=template`: `template: {id: "azerdex-welcome-v1", variables: {CTA_URL}}` + the same attachment. **Switch to it only after owner acceptance step A-4** (one real send to an owner-controlled inbox shows the emblem inline). If the provider rejects the combination, stay on `html`; no public image hosting is ever used.

## Outcomes and retries

| Provider answer | Class | Database effect |
| --- | --- | --- |
| 200/201 with a well-formed id | accepted | `sent`, provider id stored, recipient hash erased. **Accepted ≠ delivered**: no webhook is implemented, so nothing claims delivery. |
| 429 | retry (definitely not sent) | wait `max(Retry-After ≤ 3600 s, 60·2^(n-1) s)`, same key |
| timeout (headers **or body**) / transport error / 5xx / 408 / 423 / 425 / 409 / any other 2xx / malformed 2xx | **ambiguous** (may have been sent) | same key retried only inside **20 h** (Resend keeps keys 24 h); afterwards `review_required`. A 409 `invalid_idempotent_request` (payload changed within 24 h, e.g. after switching html ↔ template mode) is bounded by the 6-attempt cap and ends in review. |
| 401 / 403 | **run-level failure** (revoked key, unverified domain) | the run stops after one call; every claimed job is released with its attempt given back (`circuit_open`), **no user is parked**; log event `provider_auth_failed` must alert the operator |
| 400 / 422 / other 4xx | permanent, per recipient | `review_required`, never retried |
| expired lease (worker died) | ambiguous | as above |

Attempts are capped at 6 and 10 jobs per run (`AZERDEX_WELCOME_MAX_PER_RUN` of 0, negative or unparsable means **1**, never 10); three consecutive provider failures open a circuit for the rest of the run; a run stops starting sends after 90 s (lease 180 s, send timeout 10 s, database call timeout 10 s) and releases the rest. **There is no exactly-once guarantee**:
the database guarantees one durable event per user; the provider key de-duplicates retries inside its window; ambiguous sends beyond the window need an operator.

## Asset

`supabase/functions/azerdex-welcome-worker/azerdex-logo.png` (128×128 PNG, ≤ 16 KB; the existing optimised rune emblem) is **not in the repository yet**. The worker validates signature,
IHDR size and size cap before every run and sends nothing otherwise (`logo_invalid`). Supplying the asset is owner action A-1.
