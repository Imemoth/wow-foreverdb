# Zero-Touch Activation Origin 403 Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the browser-generated `Origin: null` failure from the native enrollment download flow without accepting opaque origins or weakening any other Account API CSRF control.

**Architecture:** Keep both proxy and route-handler origin checks fail-closed and unchanged. Change only Account HTML responses from `Referrer-Policy: no-referrer` to `strict-origin`, which preserves the real Origin on same-origin native form POSTs while ensuring Referer never includes an Account path or query string; Account API/file responses remain `no-referrer`.

**Tech Stack:** Next.js 16, TypeScript, Vitest, Playwright, GitHub Actions, Vercel Preview.

**Spec:** `docs/account-v1/zero-touch-enrollment-registered-sync.md`, `docs/account-v1/acceptance-zero-touch.md`, and the owner request for PR #56 activation-download 403 remediation dated 2026-10-14.

## Global Constraints

- Branch from PR #56 head `0decdf7323d36d82ffcd8f95caebb64fb10a2760`; do not merge #56, #57, or this fix PR.
- Never allow literal `Origin: null` globally; keep session-bound HMAC CSRF verification mandatory.
- Cross-site, spoofed-Origin, wrong-content-type, missing/invalid/foreign-session/expired-token, anonymous, unconfirmed, and expired-session requests must fail before ticket issuance.
- Do not deploy Production, change live Supabase schema/data, change registered AutoSync defaults, or generate/use a live activation ticket.
- Preserve PR #57 OWNER-ONLY / NEVER MERGE controls and reuse its existing installer/test profile after the web-only fix.

## Review Focus

- A hostile site choosing `Referrer-Policy: no-referrer` must still be rejected when it sends `Origin: null`.
- `strict-origin` must not leak `token_hash`, Account paths, or queries in Referer.
- Proxy and route-handler checks must agree and no ticket RPC may run on a rejected request.
- The native form must keep its server-rendered, session-bound HMAC token and must not move the ticket into browser JavaScript.
- Account API/file responses must remain private, no-store, noindex, and `Referrer-Policy: no-referrer`.

---

### Task 1: Reproduce and fix the native-form Origin regression

**Files:**
- Modify: `web/tests/unit/challenge.test.ts`
- Modify: `web/tests/unit/account-enrollment-routes.test.ts`
- Modify: `web/tests/account/security.spec.ts`
- Modify: `web/src/lib/security/headers.ts`
- Modify: `web/src/proxy.ts`
- Modify: `web/src/app/account/layout.tsx`

**Interfaces:**
- Consumes: Next.js proxy response headers and the existing native `<form method="post">` download contract.
- Produces: `SENSITIVE_PAGE_REFERRER_POLICY = "strict-origin"`; Account HTML responses and metadata use it, while `ACCOUNT_RESPONSE_HEADERS` stays `no-referrer`.

- [ ] **Step 1: Write the failing proxy behavior test**

Add a real `proxy()` request for `/account/devices` and assert the emitted HTML response policy is the literal `strict-origin`. Name the production regression: restoring `no-referrer` would make Chromium serialize a native form POST Origin as `null`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `vitest run tests/unit/challenge.test.ts`

Expected: FAIL because the current response is `Referrer-Policy: no-referrer`.

- [ ] **Step 3: Expand enrollment rejection coverage before implementation**

Add literal `Origin: null` and expired session-bound HMAC token cases to `account-enrollment-routes.test.ts`; assert 403 and zero RPC calls. Keep the existing valid same-origin, foreign Origin, Fetch-Metadata, content type, missing token, invalid token, other-session token, and unauthenticated/dead-session cases.

- [ ] **Step 4: Add the real-browser regression**

In `tests/account/security.spec.ts`, submit the real server-rendered Devices form with a deliberately invalid CSRF value so processing stops before authentication or ticket issuance. Assert the browser sends `Origin: http://localhost:3210`, urlencoded content type, and only the origin (not `/account/devices` or a query) in Referer; assert the server reaches the token rejection, proving the request passed both Fetch Metadata gates. Update page-vs-API referrer assertions: HTML `strict-origin`, Account APIs `no-referrer`.

- [ ] **Step 5: Implement the minimal policy fix**

Export the strict policy constant from `lib/security/headers.ts`; use it for Account page proxy responses and Account layout metadata. Do not change `originAllowed`, `isSameOriginRequest`, `verifyFormRequest`, `verifyFormToken`, the form markup, the download route, or API response headers.

- [ ] **Step 6: Run focused GREEN verification**

Run: `vitest run tests/unit/challenge.test.ts tests/unit/account-enrollment-routes.test.ts tests/unit/account-web-lib.test.ts tests/unit/account-enrollment-static.test.ts tests/unit/account-web-static.test.ts`

Expected: all tests pass; the route matrix performs zero ticket RPCs for every rejected input.

- [ ] **Step 7: Commit**

Commit message: `fix(account): preserve origin on enrollment form posts`

### Task 2: Record security rationale and owner acceptance gates

**Files:**
- Modify: `docs/account-v1/architecture.md`
- Modify: `docs/account-v1/web-auth.md`
- Modify: `docs/account-v1/web-devices.md`
- Modify: `docs/account-v1/zero-touch-enrollment-registered-sync.md`
- Modify: `docs/account-v1/acceptance-zero-touch.md`
- Create: `docs/account-v1/activation-download-origin-fix.md`

**Interfaces:**
- Consumes: Task 1 behavior and test evidence.
- Produces: Auditable root cause, fix, test/CI status, Preview-only validation plan, and exact PR #57 continuation conditions.

- [ ] **Step 1: Document the confirmed cause and bounded fix**

Record that `no-referrer` makes non-CORS native form POST Origin opaque, that `strict-origin` emits the real same-origin Origin while stripping path/query from Referer, and that `Origin: null` remains rejected at both layers.

- [ ] **Step 2: Update acceptance status without overstating evidence**

Record local test results and leave CI/Preview/Windows owner acceptance pending until observed. State that no migration, data, AutoSync flag, installer, or live ticket changed.

- [ ] **Step 3: Record the exact owner pilot continuation**

Require a green fix-PR Preview, sign-in on that Preview, browser download of one `.fdbact` from the existing test account, confirmation that the request Origin equals the Preview origin, then use the existing #57 installer on the existing Windows 10 test profile with AutoSync OFF. No new profile or installer.

- [ ] **Step 4: Commit**

Commit message: `docs(account): record activation download origin fix`

### Task 3: Verify, independently review, and publish the PR

**Files:**
- Verify only; amend Task 1 or Task 2 files only for Critical/Important review findings with a new failing test first.

**Interfaces:**
- Consumes: Tasks 1-2 commits.
- Produces: Fresh local evidence, independent security findings, pushed branch, draft PR targeting `account/v1-zero-touch-enrollment-registered-sync`, CI status, and Preview validation state.

- [ ] **Step 1: Run local quality and security suites**

Run lint, TypeScript typecheck, the full Vitest suite, production build, bundle-secret scan, and the focused Account enrollment/security tests. Record exact counts and any environment-limited suite separately.

- [ ] **Step 2: Run an independent whole-branch security review**

Give a fresh reviewer the merge-base-to-HEAD diff, this plan/spec, and the Review Focus list. Fix every Critical/Important finding with RED→GREEN proof; ledger Minor findings.

- [ ] **Step 3: Re-run final verification**

Re-run the full affected suite after review fixes and inspect `git diff --check`, status, and commit range.

- [ ] **Step 4: Push and open a non-merged PR**

Push `fix/zero-touch-enrollment-origin-403`; create a draft PR against `account/v1-zero-touch-enrollment-registered-sync`, attach it to this task, and do not merge or deploy Production.

- [ ] **Step 5: Inspect Actions and Preview**

Wait for relevant GitHub Actions. Report each workflow conclusion and whether a new Vercel Preview exists. If Preview is unavailable, document the exact safe redeploy/test procedure without generating a ticket.

