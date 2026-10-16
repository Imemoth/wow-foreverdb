# Owner-only Zero-Touch Production-Supabase Pilot (2026-10-13)

**WARNING: NEVER MERGE THIS BRANCH TO main/release OR PUBLISH ITS BINARY AS A GENERAL RELEASE.**

Branch: `companion/private-zero-touch-owner-pilot-20261013`, based on PR #56. The ONLY product approval newly enabled here is `ZeroTouchEnrollmentApproved = true`; `ProductionAccountAuthApproved = false` and `DeviceAutoSyncApproved = false` stay OFF. The inherited private pilot source flags from #53-#55 remain ON **only** in this isolated draft/test branch. Account mode remains disabled by default unless explicitly set for one Companion process.

**Not staging:** this runs a bounded owner-only acceptance on the existing live private Supabase project, migration `zero_touch_enrollment` applied on 2026-10-13. A destructive rollback is not authorized. Preserve the six anonymous installs and the linked 140 source stats / 46 Guildbook members. No data writes unless owner starts a fresh, isolated test installation.

## 1. Build

Run the existing GitHub Actions workflow **Build ForeverDB Installer** by hand using branch `companion/private-zero-touch-owner-pilot-20261013`. Verify that the workflow checkouts the pilot branch, that the commit contains `ZeroTouchEnrollmentApproved = true`, and that the installer artifact is from that SHA. Use GitHub artifacts ONLY for owner validation; no release, no automatic sync. Existing installer has the activation-file copy feature.

## 2. Web prerequisite

Vercel project `wow-foreverdb` (SSO protection **enabled for all deployments**) has separate per-Git-branch Preview env for PR #56 (`account/v1-zero-touch-enrollment-registered-sync`), not inherited from #53. Five nonsensitive variables have been configured:
- `ACCOUNT_AUTH_MODE=pilot`
- `ACCOUNT_AUTH_URL=https://klxhikdlfwgxurdyexdi.supabase.co`
- `ACCOUNT_AUTH_PROJECT_REF=klxhikdlfwgxurdyexdi`
- `SITE_URL=https://wow-foreverdb-git-account-v1-zero-touc-7b455a-imemoths-projects.vercel.app`
- `RATE_LIMIT_BACKEND=upstash`

**Configured directly on the #56 Preview branch (2026-10-13):** `ACCOUNT_AUTH_PUBLISHABLE_KEY` (the existing active modern Supabase publishable key), plus freshly and independently generated 256-bit `ACCOUNT_CSRF_SECRET`, `CHALLENGE_COOKIE_SECRET`, and `RATE_LIMIT_SALT`. None of those values should be pasted in chat or committed to GitHub. Shared Preview Upstash credentials already exist project-wide.

**Owner action still required:** add only `TURNSTILE_SECRET_KEY` (sensitive) and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (public site key) to this exact Preview branch, using the matching existing Cloudflare Turnstile widget credentials. Ensure the widget allows the stable #56 Preview hostname. Do not broaden these or the Account Auth variables to Production or to every Preview branch.

Cloudflare Turnstile host allowlist must cover the stable #56 preview hostname if using host-restricted Turnstile. Deploy new Preview after editing vars; verify SSO and `/account/devices` page behind registered login, and download an activation file ONLY when Windows first-run is ready. Every ticket is usable once for 168 hours; keep the .fdbact private.

## 3. Windows pilot — isolated local user

Use the already accepted independent Windows 10 test login, not the regular Companion user. Keep AutoSync OFF. Back up that test profile's local ForeverDB data if any; **do not** copy the original profile's `session.dat`, registered Auth vault, SavedVariables or installation ID.

Install the new **pilot-branch** installer (not the previously validated PR #56 default-off installer). The normal installer may start the application once in default mode; close it before activating. Never configure or point it at the usual WoW account's live `WTF/SavedVariables` folder.

**Fast path (recommended for this isolated Windows test user):** use `scripts/owner-zero-touch-fixture-and-launch.ps1` from this exact pilot branch. It creates a **new** synthetic `H|7|...` SavedVariables export in `%LOCALAPPDATA%\ForeverDB-ZeroTouch-TestRoot`, points the test profile's Companion settings at it, forcibly sets AutoSync OFF, reads the *publishable* key already present in that test profile's settings, and launches the Companion only in a process-local `private-pilot` mode. It refuses to replace any pre-existing real WoW root and never reads or copies the live WoW directory. The fixture has zero guilds/sources, so the test should verify the registered device and successful *empty* manual ingest, **not** expect the existing 46-member historical Guildbook to appear under the new installation. Keep original installed files untouched outside this test profile.

After installing the pilot artifact, log in as `ForeverDB-Test` or the separate test Windows user, confirm the normal Companion is closed, download `foreverdb-activation.fdbact` into that user's **Downloads** folder, and run the script with PowerShell from a trusted checkout of this pilot branch. Do not change `ExecutionPolicy` for the machine or user globally. If script execution is blocked, run via a process-scoped policy only after reviewing the source.

In the test user's *one* PowerShell process, set:
```powershell
$env:FOREVERDB_ACCOUNT_MODE = "private-pilot"
$env:FOREVERDB_ACCOUNT_SUPABASE_URL = "https://klxhikdlfwgxurdyexdi.supabase.co"
$env:FOREVERDB_ACCOUNT_PROJECT_REF = "klxhikdlfwgxurdyexdi"
$env:FOREVERDB_ACCOUNT_SUPABASE_KEY = Read-Host "Enter the public sb_publishable_ key from Supabase (not a secret/service key)"
& "$env:LOCALAPPDATA\Programs\ForeverDB\ForeverDB.Companion.exe"
Remove-Item Env:FOREVERDB_ACCOUNT_SUPABASE_KEY,Env:FOREVERDB_ACCOUNT_MODE,Env:FOREVERDB_ACCOUNT_SUPABASE_URL,Env:FOREVERDB_ACCOUNT_PROJECT_REF -ErrorAction SilentlyContinue
```
**Do not use `private-claim-pilot` mode**; it requires a prior scoped installation. Do NOT add persistent global Windows env vars; close the process to switch the pilot off.

The first-run enrollment requires **exactly one new installation ID**, generated by an isolated Addon SavedVariables export for this test profile. An empty WoW root has no installation ID: that is an expected `Pending activation` state, not a backend bug. Never generate a second owner for the already registered historical installation. Use a separate copy of the game WTF directory or a reviewed synthetic fixture; never use the existing live SavedVariables by accident.

Put `foreverdb-activation.fdbact` (from the signed-in owner Preview `/account/devices`) in the test Windows user's Downloads folder or alongside the installer *before launching the gated pilot process*. It contains a live one-time bearer ticket: do not copy it to chat, screenshots, GitHub, OneDrive or shared folders. In production owner-only pilot, **do not intentionally demonstrate ticket theft**; test replay and races only on disposable local SQL.

Once an isolated test install ID exists, activation is expected to use its own new anonymous device JWT and registry to enroll automatically, with no Companion sign-in or claim code. Verify `/account/devices` lists exactly one new device. Only then do **one manual Sync Now**, with a reviewed synthetic test snapshot. Do not enable registered AutoSync. Verify history, Guildbook and other anonymous installs unchanged.

## 4. Release/rollback gates

No #53-#56 merge or promotion. Run `python3 scripts/check-pilot-flags.py --require-off` only for main/release integration and expect it to FAIL here, deliberately. Revert this branch after pilot; do not reuse binaries. Built-in non-destructive SQL kill switch exists at `database/rollback/0014_kill_switch.sql`, but executing on the live DB requires owner approval and a reviewed incident plan.

**Acceptance statuses:** Existing PR #56 Windows installer/UI smoke (standard default-off binary) PASS. Pilot branch build NOT RUN. PR #56 protected Preview Account/Devices NOT VERIFIED. Windows owner Z2-Z10 NOT RUN. Production migration 0014 APPLIED; initial post-migration checks PASS; 0 new tickets/devices. Independent security review and public release still OPEN.
