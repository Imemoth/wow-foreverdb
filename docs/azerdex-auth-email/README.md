# AzerDex Auth e-mail (Resend) — V1

Supabase Auth stays the identity authority. Resend only delivers and renders. No custom tokens, no parallel authentication.

```
Supabase Auth ──(Send Email hook, Standard Webhooks signature)──▶ azerdex-auth-email ──▶ Resend (published template + CID emblem)
                                                                        │ link = <fixed base>/auth/confirm?type=…&token_hash=<Auth's hash>
recipient ──GET (no side effect)──▶ web /auth/confirm ──button POST──▶ web /auth/confirm/submit ──▶ azerdex-auth-confirm ──▶ Auth /verify
```

## Templates (Resend, published, source in `templates/`)

| Alias | Used for (`email_action_type`) | Variables |
| --- | --- | --- |
| `azerdex-confirm-signup-v1` | `signup` | `CONFIRM_URL` |
| `azerdex-reset-password-v1` | `recovery` | `RESET_URL` |
| `azerdex-email-change-v1` | `email_change` (both addresses when secure change is on) | `CONFIRM_URL`, `NEW_EMAIL` |
| `azerdex-auth-link-v1` | `invite`, `magiclink`, `email` | `TITLE`, `MESSAGE`, `BUTTON_LABEL`, `CONFIRM_URL` |
| `azerdex-auth-code-v1` | `reauthentication` | `CODE` |
| `azerdex-auth-notice-v1` | the 7 `*_notification` types | `TITLE`, `MESSAGE` |

`azerdex-welcome-v1` is untouched. All templates share the welcome layout (header with the `cid:azerdex-logo` emblem, palette `#07091C/#0D0F33/#191A47/#6C41C7/#D9B978`, support footer), declare their variables without fallbacks (a missing variable is a provider error, not a broken email),
carry a plain-text alternative, and use no external image. Edit visually in the Resend dashboard if wanted; `node scripts/build-azerdex-auth-templates.mjs` regenerates the reviewed source (CI `--check`s it).
Every one of the 14 documented action types is handled; an undocumented new type is refused with a 400 contract answer (Auth shows an error) and never silently dropped.
`invite` / `magiclink` / `email` deliver correctly, but no AzerDex flow uses them and the public confirm page does not consume them (it supports `signup`, `email_change`, `recovery`).

## Secrets / settings (Edge Function secrets of project `klxhikdlfwgxurdyexdi`)

| Name | Function | Notes |
| --- | --- | --- |
| `SEND_EMAIL_HOOK_SECRET` | `azerdex-auth-email` | the `v1,whsec_…` value Supabase shows when the hook is created (Authentication → Hooks). Fail-closed when unset. |
| `RESEND_API_KEY` | both e-mail functions | already present (shared with the welcome worker) |
| `AZERDEX_AUTH_LINK_BASE` | `azerdex-auth-email` | optional; exact allowlist `https://beta.azerdex.com` (default), `https://azerdex.com`, `https://www.azerdex.com` |
| `AZERDEX_CONFIRM_ENDPOINT` | **website** (Vercel env, server-side) | `https://<ref>.supabase.co/functions/v1/azerdex-auth-confirm`; opaque to the web source (a static test forbids the project ref in it) |

## Rollout and rollback

1. Deploy both functions (done; `verify_jwt=false`, each authenticates itself) and set the secrets above.
2. Enable the hook: Authentication → Hooks → **Send Email** → HTTPS → `https://<ref>.supabase.co/functions/v1/azerdex-auth-email`. While enabled, Auth does NOT use SMTP (no duplicates).
3. **Rollback:** disable the hook in the same screen. Auth immediately returns to its configured SMTP; nothing is deleted. The SMTP settings are deliberately left in place.
4. Welcome worker: `AZERDEX_WELCOME_MODE=template` (secret) after checking `select status,count(*) from private.azerdex_welcome_outbox group by 1` shows no `pending/retry/leased` rows. Fallback: unset it (code default is `html`) or use `database/rollback/0015_kill_switch.sql`.

## Public confirm page

`/auth/confirm` is outside the Account zone and independent of the Account feature flags. GET has no side effect; the visitor's button POST goes to `/auth/confirm/submit`, which forwards `{type, token_hash[, password]}` to `azerdex-auth-confirm`.
That function calls Auth's own `/verify` (signup, email_change) or verify + set password + global logout (recovery) and returns no session. **Reachability:** `azerdex.com` is behind Vercel SSO (all deployments), so an anonymous recipient cannot open links there;
`beta.azerdex.com` answers anonymously (checked from outside Vercel), which is why the link base defaults to it. The page must be deployed on the branch that serves `beta.azerdex.com` (`web/azerdex-beta`).

## Tests

`tests/auth-email/*.test.mjs` (hook + confirm function, mocked Resend/Auth, real Deno type-check in CI), `web/tests/unit/auth-confirm.test.ts`. Logs carry counts and allowlisted codes only (asserted: no token, link, address, key or secret).
