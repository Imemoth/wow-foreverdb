# Account Linking MVP: clean Windows first-install test

Use the normal `ForeverDB-Companion-win-x64` artifact produced by the existing **Build ForeverDB Companion** workflow. It is the same self-contained `win-x64` package intended for release; there is no acceptance-only binary or configuration.

An empty WoW root is not a new ForeverDB installation. The addon creates its installation ID and writes it into `WTF\Account\<account>\SavedVariables\ForeverDB.lua`; the Companion only discovers IDs from those files. Account sessions and the registered-device credential are separate, DPAPI-protected state under the current Windows user's `%LOCALAPPDATA%\ForeverDB`. Changing the WoW root does not create or replace either kind of identity.

The Account tab may continue showing an installation discovered before a Settings change until the Companion process exits. Closing the window only hides it in the notification area. Use the tray icon's **Exit** command to end the process. A restart with an empty root shows no locally discovered installation, but it still is not a fresh-user test because the Windows profile's account and device credentials remain intact.

## Owner acceptance outcome (2026-10-21)

**PASS on the normal Windows build, without Windows Sandbox.** The owner used an explicitly disposable Windows test profile, removed its obsolete `%LOCALAPPDATA%\ForeverDB` test-only application state, configured an isolated WoW test root and generated a fresh schema-9 SavedVariables installation ID. Anonymous manual sync, registered account sign-in, installation connection/device registration, and subsequent manual sync all passed. The final snapshot contained 0 sources and 0 Guildbook members; non-empty data behavior remains untested. See [acceptance record](account-linking-mvp-acceptance.md).

**Important:** deleting `%LOCALAPPDATA%\ForeverDB` resets Companion authentication/device credentials and local settings **only for that Windows user**. It is appropriate only if the user explicitly accepts losing that test-only state; do **not** delete the Windows DPAPI key store, production user credentials, or WoW SavedVariables. On a real user profile, use the isolation options below instead.

## Isolate the test from existing ForeverDB data

For profiles containing valuable installations, Windows Sandbox is the preferred test environment. Its `%LOCALAPPDATA%`, DPAPI keys and filesystem are separate from the host and are discarded when the Sandbox closes. Do not delete, rename or reuse the host's `%LOCALAPPDATA%\ForeverDB`, WoW installation, `WTF` directory or SavedVariables. A new local Windows user is the supported fallback because DPAPI `CurrentUser` gives it the same isolation.

1. Download the normal workflow artifact on the host and open Windows Sandbox (or use a clean local Windows test user as described below).
2. Copy the artifact ZIP into the Sandbox and extract it to `C:\ForeverDB-Test`. Do not run it from inside the ZIP.
3. In Sandbox PowerShell, create a disposable SavedVariables tree and a new installation ID:

   ```powershell
   $root = 'C:\ForeverDB-Test-WoW'
   $saved = Join-Path $root 'WTF\Account\TEST\SavedVariables'
   New-Item -ItemType Directory -Force -Path $saved | Out-Null
   $id = [guid]::NewGuid().ToString('N')
   $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
   $export = 'ForeverDB_Export = "H|9|0.5.0-alpha|{0}|{1}"' -f $id, $now
   Set-Content -Path (Join-Path $saved 'ForeverDB.lua') -Value $export -Encoding Ascii
   Write-Host "Disposable installation: $id"
   ```

This creates a header-only snapshot with zero source rows and zero Guildbook members, entirely inside the Sandbox. It does not copy or edit any historical installation ID, credential or SavedVariables file.

## Exercise the release flow

1. Launch `C:\ForeverDB-Test\ForeverDB.Companion.exe` with no `FOREVERDB_ACCOUNT_*` environment variables.
2. In Settings, set the WoW root to `C:\ForeverDB-Test-WoW`, turn **Auto Sync** off, and save.
3. On Account, choose anonymous mode if prompted. On Status, choose **Sync now**. Expect a successful anonymous sync with zero source rows and zero Guildbook members. On Account, confirm the disposable installation ID appears and that sign-in is available.
4. Sign in with an existing confirmed ForeverDB account. Access and refresh tokens must not appear in the UI, URL or logs.
5. On the disposable installation, choose **Connect this installation** and confirm. Expect the account to own the same installation ID and the Companion to show a registered device.
6. Return to Status and choose **Sync now**. Expect a successful manual device sync. Leave Auto Sync off.
7. Close Windows Sandbox when finished. Its local profile, DPAPI credentials and disposable SavedVariables are destroyed; the host's existing ForeverDB data remains untouched.

The test performs normal account, ownership and device-data operations through already-deployed APIs. It does not apply a migration, change hosted Supabase configuration, deploy a service or publish an installer.

If Windows Sandbox is unavailable:

1. In Windows **Settings → Accounts → Other users**, create a local user such as `ForeverDBAcceptance` (**Add account → I don't have this person's sign-in information → Add a user without a Microsoft account**).
2. Sign out of the historical test user and sign in to `ForeverDBAcceptance`; do not merely change folders inside the old profile.
3. Copy or download the same normal artifact, create the header-only SavedVariables fixture above under a new root owned by this user, and perform the release flow.
4. Keep the new profile until acceptance evidence is recorded. Never point it at an existing `WTF` tree.
