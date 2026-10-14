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

Pre-PR local evidence: the focused suite is **140/140 pass** and TypeScript is clean. Full local verification, independent security review, GitHub
Actions conclusions and the fix-branch Preview are recorded only after they actually run; until then they remain **PENDING**.

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

Owner acceptance remains **BLOCKED** until steps 2-4 have green evidence and the owner explicitly authorizes the one live ticket. Windows Z2/Z3
can then continue with the existing #57 artifact and test profile; Z13 public one-download packaging remains independently BLOCKED.
