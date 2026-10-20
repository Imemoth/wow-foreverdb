# Account Linking MVP: clean Windows first-install test

Use the normal `ForeverDB-Companion-win-x64` artifact produced by the existing **Build ForeverDB Companion** workflow. It is the same self-contained `win-x64` package intended for release; there is no acceptance-only binary or configuration.

## Isolate the test from existing ForeverDB data

Windows Sandbox is the preferred test environment. Its `%LOCALAPPDATA%`, DPAPI keys and filesystem are separate from the host and are discarded when the Sandbox closes. Do not delete, rename or reuse the host's `%LOCALAPPDATA%\ForeverDB`, WoW installation, `WTF` directory or SavedVariables.

1. Download the normal workflow artifact on the host and open Windows Sandbox.
2. Copy the artifact ZIP into the Sandbox and extract it to `C:\ForeverDB-Test`. Do not run it from inside the ZIP.
3. In Sandbox PowerShell, create a disposable SavedVariables tree and a new installation ID:

   ```powershell
   $root = 'C:\ForeverDB-Test-WoW'
   $saved = Join-Path $root 'WTF\Account\TEST\SavedVariables'
   New-Item -ItemType Directory -Force -Path $saved | Out-Null
   $id = [guid]::NewGuid().ToString('N')
   $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
   $export = 'ForeverDB_Export = "H|9|0.5.0-alpha|{0}|{1}\nS|creature|1|1|Test%20Wolf"' -f $id, $now
   Set-Content -Path (Join-Path $saved 'ForeverDB.lua') -Value $export -Encoding Ascii
   Write-Host "Disposable installation: $id"
   ```

This creates test data only inside the Sandbox. It does not copy or edit any historical installation ID, credential or SavedVariables file.

## Exercise the release flow

1. Launch `C:\ForeverDB-Test\ForeverDB.Companion.exe` with no `FOREVERDB_ACCOUNT_*` environment variables.
2. In Settings, set the WoW root to `C:\ForeverDB-Test-WoW`, turn **Auto Sync** off, and save.
3. On Status, choose **Sync now**. Expect a successful anonymous sync. On Account, confirm the disposable installation appears and that sign-in is available.
4. Sign in with an existing confirmed ForeverDB account. Access and refresh tokens must not appear in the UI, URL or logs.
5. On the disposable installation, choose **Connect this installation** and confirm. Expect the account to own the same installation ID and the Companion to show a registered device.
6. Return to Status and choose **Sync now**. Expect a successful manual device sync. Leave Auto Sync off.
7. Close Windows Sandbox when finished. Its local profile, DPAPI credentials and disposable SavedVariables are destroyed; the host's existing ForeverDB data remains untouched.

The test performs normal account, ownership and device-data operations through already-deployed APIs. It does not apply a migration, change hosted Supabase configuration, deploy a service or publish an installer.

If Windows Sandbox is unavailable, use a new local Windows user plus a new disposable WoW root. Never point that profile at an existing `WTF` tree, and remove only the new Windows user after testing.
