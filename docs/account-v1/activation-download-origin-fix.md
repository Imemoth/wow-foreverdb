# Activation-file download `Origin: null` / 403 repair

**Date:** 2026-10-14
**Scope:** web-only repair stacked on PR #56; PR #57 remains OWNER-ONLY / NEVER MERGE.
**Safety state:** no Production deployment, live database/schema mutation, installer rebuild, AutoSync change or activation-ticket use is authorized by this document.

## Root cause — CONFIRMED

The signed-in `/account/devices` page rendered a native
`<form method="post" action="/account/api/enrollment/download">` and correctly included a session-bound HMAC CSRF token. The Account proxy and
layout also applied `Referrer-Policy: no-referrer` to that HTML document. For a native non-CORS form POST, that policy makes the browser serialize
the request's Origin as literal `null`. The reproduced Preview request therefore had:

- `Origin: null`
- `Sec-Fetch-Site: same-origin`
- `Sec-Fetch-Mode: navigate`
- `Content-Type: application/x-www-form-urlencoded`

The first 403 came from the proxy's `isSameOriginRequest` pre-check, before rate-limit charging or route code. The form handler's
`verifyFormRequest` independently has the same fail-closed rule. Both behaved as designed: a server cannot safely distinguish a same-origin page
made opaque by its own policy from an attacker-controlled opaque-origin document merely from `Origin: null` plus spoofable non-browser headers.

## Implemented fix

Account **HTML pages** now use `Referrer-Policy: strict-origin` in both the response header and metadata. On the HTTPS Preview, a same-origin native
form POST now carries the exact Preview Origin. Referer, when present, contains only the origin and never `/account/devices`, a query string or an
email callback `token_hash`.

The change deliberately does **not**:

- allow literal `Origin: null` in `csrf.ts`, `challenge.ts`, the proxy or any Account route;
- change the native form, move the ticket through browser JavaScript, or expose it in a URL/header/log;
- weaken the session-bound HMAC token, Fetch Metadata or urlencoded content-type checks;
- change Account API/file response policy (`no-referrer`, `private, no-store`, noindex, CSP);
- alter enrollment RPCs, migration 0014, data, Companion flags, `DeviceAutoSyncApproved`, or the #57 installer.

## Regression and security tests

The fix branch adds or retains checks for:

- real proxy response policy for `/account/devices` (`strict-origin`);
- real-browser submission from the server-rendered Devices form through the real proxy and route: concrete same-origin Origin, urlencoded body,
  origin-only Referer, and a deliberate invalid-token rejection proving that the browser-supplied Fetch Metadata passed both request gates before
  processing stopped (no ticket RPC);
- normal same-origin route POST producing the activation attachment;
- literal `Origin: null`, foreign Origin, cross-site/same-site Fetch Metadata and missing request metadata;
- missing, malformed, other-session, anonymous-bound, wrong-key and expired HMAC CSRF tokens;
- JSON, multipart and text content types; duplicate/extra fields;
- anonymous, dead/expired, unconfirmed and anonymous Auth users;
- zero ticket RPC calls for the complete rejection matrix.

Pre-PR local evidence on commit `0058f58`: focused suite **140/140 pass**; all other unit/static/security tests **360/360 pass**; TypeScript,
lint, production build, the 47-file bundle-secret scan and production dependency audit pass (0 vulnerabilities). The one full-suite exception is an
unchanged, Windows-only CRLF portability failure in `account-migration-conformance.test.ts` (`396/397` overall): its LF-only Markdown fence regex
does not match the CRLF checkout. The Linux CI result is authoritative for that unrelated test.

An independent security review confirmed the root cause and found no Critical production issue. Its one Important finding was that Playwright
request interception happens before Chromium attaches Fetch Metadata, making the first form-test assertion invalid. The corrected test now reaches
the real server and deliberately fails at the distinct session-bound token verdict; this proves the real request passed both metadata gates while
preventing authentication and the ticket RPC. Review whitespace findings were also fixed.

GitHub Actions on code/evidence commit `1b4d59c` are **PASS**: Web code quality, Web E2E (Playwright), Web release gate, both CodeQL checks,
Account web auth (real GoTrue), Account end-to-end (GoTrue + PostgREST), Account ownership SQL + real GoTrue, Windows Companion account auth,
publisher/pipeline and collector smoke. The SQL job's first attempt exposed the existing 30-round race test's stochastic interaction with the
10-device limit (`device_limit` instead of `ticket_revoked`); its isolated rerun passed without a source change. Supabase Preview was intentionally
skipped because per-PR database branches are disabled; this web-only change neither needs nor creates one.

Evidence: [web / Playwright / release / CodeQL run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38548338234),
[Account web-auth run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38548338193),
[Account end-to-end run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38548338171),
[Account ownership SQL rerun](https://github.com/Imemoth/wow-foreverdb/actions/runs/38548338196),
[Windows Companion run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38548338192), and
[collector smoke run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38548338262).

Vercel deployment `dpl_7dxVjwjeLSmZjPitMSeXXEksTgCu` for exact commit `1b4d59c` is **READY** at
`https://wow-foreverdb-git-fix-zero-touch-enrol-c79f66-imemoths-projects.vercel.app`. It remains protected by Vercel SSO/Deployment Protection.
The automation connection could inspect deployment metadata but was not authorized to create a protection-bypass link, so no runtime sign-in,
header check or ticket issuance was attempted. That is an owner acceptance step, not a reason to weaken protection.

## Preview-only validation and PR #57 continuation gate

The old #56 Preview URL points at the old #56 branch and cannot prove this separate fix branch. Use only the new fix PR's Vercel Preview.

1. Keep the PR targeted at `account/v1-zero-touch-enrollment-registered-sync`; do not merge it and do not deploy Production.
2. Verify the fix-branch Preview has the same required **Preview-only** Account, limiter and Turnstile settings as the protected #56 Preview, but
   with `SITE_URL` equal to the new fix Preview origin. Keep secrets in Vercel; never copy them into GitHub, logs or chat. Keep SSO/Deployment
   Protection enabled and ensure the Turnstile hostname allowlist contains only the exact fix Preview hostname needed for the test.
3. Require green web quality, Account web-auth, Account integration/security and CodeQL checks on the exact fix commit. Confirm the Preview response
   for `/account/devices` is `private, no-store`, noindex, CSP-protected and `Referrer-Policy: strict-origin`.
4. Sign in with the existing separate pilot test account. In browser developer tools confirm the download POST has `Origin` equal to the fix
   Preview origin, `Sec-Fetch-Site: same-origin`, urlencoded content type and a 200 attachment response. Only then download **one** `.fdbact`;
   keep it private. This is the first authorized point that creates a live ticket, so it requires the owner's explicit go-ahead.
5. Reuse installer commit `b3d887031f788e20b4ecd65ff644bc798ad8052e` from PR #57 and the existing separate Windows 10 test profile. Do not
   request a new profile or build a new installer: this repair changes only the website response policy.
6. Keep AutoSync OFF. Place the single downloaded file in that isolated test user's Downloads folder, launch the existing owner-only pilot with
   the already reviewed process-local settings, confirm exactly one new test device appears, and perform at most the separately approved manual
   Sync Now. Preserve the six anonymous installations, 140 source-stat rows and 46 Guildbook members.

Owner acceptance remains **BLOCKED** until the owner completes the protected runtime checks in steps 2-4 and explicitly authorizes the one live ticket. Windows Z2/Z3
can then continue with the existing #57 artifact and test profile; Z13 public one-download packaging remains independently BLOCKED.
