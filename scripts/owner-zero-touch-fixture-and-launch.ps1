# ForeverDB owner-only zero-touch E2E helper.
# ONLY execute in the separate Windows 10 TEST user, with the dedicated pilot installer.
# No network write occurs in this script; it only creates an isolated synthetic WoW export and launches the Companion.
# Do not execute from the real Companion user. Do not copy real WTF, session.dat or SavedVariables.
$ErrorActionPreference = 'Stop'
$expectedOrigin = 'https://klxhikdlfwgxurdyexdi.supabase.co'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\ForeverDB\ForeverDB.Companion.exe'
$settingsPath = Join-Path $env:LOCALAPPDATA 'ForeverDB\settings.json'
$testRoot = Join-Path $env:LOCALAPPDATA 'ForeverDB-ZeroTouch-TestRoot'
$fakeExport = Join-Path $testRoot 'WTF\Account\FOREVERDB_PILOT\SavedVariables\ForeverDB.lua'

if (-not (Test-Path -LiteralPath $exe)) { throw 'Pilot Companion is not installed for this Windows user. Install from the OWNER PILOT branch first.' }
if (-not (Test-Path -LiteralPath $settingsPath)) { throw 'Run the newly installed Companion once, close it, and try again.' }
if ((Get-Process -Name 'ForeverDB.Companion' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'Close the currently running Companion before using this pilot launcher.'
}
$cfg = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
if ($cfg.SupabaseUrl -ne $expectedOrigin -or -not ([string]$cfg.SupabaseKey).StartsWith('sb_publishable_')) {
    throw 'The test profile has an unexpected Supabase URL or publishable key; no changes made.'
}
# Refuse to replace any existing nonempty real WowRoot. Test users must opt in.
if (-not [string]::IsNullOrWhiteSpace([string]$cfg.WowRoot) -and
    -not [string]::Equals([string]$cfg.WowRoot, $testRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'This Windows profile already has a real WoW root; refusing to change it. Use the isolated test profile.'
}
if (-not (Test-Path -LiteralPath $fakeExport)) {
    $folder = Split-Path -Parent $fakeExport
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $newId = [guid]::NewGuid().ToString('N')
    $utcSeconds = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $exportLine = 'ForeverDB_Export = "H|7|0.9.0-alpha|' + $newId + '|' + $utcSeconds + '"'
    Set-Content -LiteralPath $fakeExport -Value $exportLine -Encoding UTF8
    Write-Host 'New disposable installation fixture created in this Windows test user only.'
}
$cfg.WowRoot = $testRoot
$cfg.AutoSync = $false
$cfg | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $settingsPath -Encoding UTF8
Write-Host 'Synthetic WoW root configured; AutoSync forced OFF. The script does not upload data.'
Write-Host 'Download a NEW foreverdb-activation.fdbact from the owner-only Preview to THIS user Downloads folder before launch.'
Write-Host 'The one-time file contains a bearer ticket: do not share it or include it in screenshots.'
$env:FOREVERDB_ACCOUNT_MODE = 'private-pilot'
$env:FOREVERDB_ACCOUNT_SUPABASE_URL = $expectedOrigin
$env:FOREVERDB_ACCOUNT_PROJECT_REF = 'klxhikdlfwgxurdyexdi'
$env:FOREVERDB_ACCOUNT_SUPABASE_KEY = [string]$cfg.SupabaseKey
try {
    & $exe
} finally {
    Remove-Item Env:FOREVERDB_ACCOUNT_MODE,Env:FOREVERDB_ACCOUNT_SUPABASE_URL,Env:FOREVERDB_ACCOUNT_PROJECT_REF,Env:FOREVERDB_ACCOUNT_SUPABASE_KEY -ErrorAction SilentlyContinue
}
