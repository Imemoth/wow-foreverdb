[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ArtifactZip,
  [Parameter(Mandatory=$true)][string]$CompanionDirectory,
  [string]$ReportDirectory = (Join-Path $env:USERPROFILE 'Desktop\ForeverDB-Acceptance'),
  [switch]$NonInteractive
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'GuildbookAcceptance.Core.psm1') -Force
$head = 'b47606061e21173ac091916e100cd51988d7ba90'
$sha = '109d5a768c33b47afdc4ced86b2c92783feafe94fec86009d6341cfef1d79ced'
$store = Join-Path $env:LOCALAPPDATA 'ForeverDB\guildbook'
$checks = New-Object 'System.Collections.Generic.List[object]'
function Add-Check([string]$id,[string]$evidence,[string]$status,[string]$code) {
  $checks.Add((New-AcceptanceCheck -Id $id -Evidence $evidence -Status $status -Code $code))
  Write-Host "[$status] $id ($code)"
}
function Manual([string]$id,[string]$instruction) {
  Write-Host ""
  Write-Host "MANUAL: $instruction" -ForegroundColor Cyan
  if ($NonInteractive) { Add-Check $id 'NOT_VERIFIED' 'BLOCKED' 'MANUAL_NOT_RUN'; return }
  do { $v=(Read-Host 'P=PASS, F=FAIL, B=BLOCKED / not observed').Trim().ToUpperInvariant() } until ($v -in @('P','F','B'))
  if ($v -eq 'P') { Add-Check $id 'MANUAL' 'PASS' 'USER_ATTESTED' }
  elseif ($v -eq 'F') { Add-Check $id 'MANUAL' 'FAIL' 'USER_REPORTED_FAILURE' }
  else { Add-Check $id 'NOT_VERIFIED' 'BLOCKED' 'NOT_VERIFIED' }
}
function Scan([string]$id) {
  $s=Get-GuildbookStoreState -Root $store
  Add-Check $id 'AUTO' $(if($s.Pass){'PASS'}else{'FAIL'}) $s.Code
  return $s
}
Write-Host 'Guildbook Local-Only V1 / Windows acceptance - read-only harness'
Write-Host "Pinned source HEAD: $head"
Write-Host 'No companion launch, upload, network call, migration or modification is performed by the script.'
try {
  $e=Test-AcceptanceEnvironment
  Add-Check 'windows_dpapi' 'AUTO' $(if($e.Pass){'PASS'}else{'BLOCKED'}) $e.Code
  $a=Test-CompanionArtifact -ArchivePath $ArtifactZip -CompanionDirectory $CompanionDirectory -ExpectedArchiveSha $sha
  Add-Check 'pinned_artifact' 'AUTO' $(if($a.Pass){'PASS'}else{'BLOCKED'}) $a.Code
  if ($e.Pass -and $a.Pass) {
    Write-Host "Package version: $($a.Version)"
    $before=Scan 'storage_initial'
    Manual 'verified_sign_in' 'Sign in as test account A; confirm server-verified Registered identity. Never enter credentials here.'
    Manual 'local_capture' 'With Auto Sync OFF, trigger fresh Guildbook data in WoW then /reload. Confirm A data in Companion. Do not upload.'
    $afterA=Scan 'storage_after_a'
    Add-Check 'encrypted_file_a' 'AUTO' $(if($afterA.Pass -and $afterA.FileCount -gt 0){'PASS'}else{'FAIL'}) 'DPAPI_CURRENT_USER_ENVELOPE'
    Manual 'restart_restore' 'Exit via system tray Exit (window close is insufficient); restart and confirm A data returns without new capture.'
    Manual 'offline_restore' 'After successful online verification, exit, disconnect network, restart and confirm A data. Reconnect before continuing.'
    Manual 'signout_ui_clear' 'Sign out A; confirm all private Guildbook views clear.'
    $afterSignout=Scan 'storage_after_signout'
    Add-Check 'signout_files_preserved' 'AUTO' $(if(Test-StorePreserved -Before $afterA -After $afterSignout){'PASS'}else{'FAIL'}) 'UNCHANGED_STORE_EXPECTED'
    Manual 'account_b_isolated' 'Sign into verified test account B; confirm A Guildbook does not appear.'
    Manual 'stale_a_rejected' 'Observe replay of old A capture under B, if safely possible. Confirm it never replaces B. Otherwise choose BLOCKED.'
    Manual 'account_b_capture' 'Produce a fresh B capture with Auto Sync OFF and confirm B data is visible.'
    $afterB=Scan 'storage_after_b'
    Add-Check 'account_b_new_namespace' 'AUTO' $(if(Test-SeparateAccountCreated -Before $afterSignout -After $afterB){'PASS'}else{'FAIL'}) 'NEW_HASHED_ACCOUNT_NAMESPACE_EXPECTED'
    Manual 'account_a_restore' 'Sign out B, sign into A and confirm A returns while B remains isolated.'
    Manual 'public_sync' 'ONLY on a separately authorized disposable PRIVATE backend: manually Sync now with synthetic public observations. Otherwise BLOCKED; do not upload to production.'
    Manual 'no_guildbook_rpc' 'ONLY with authorized sanitized endpoint telemetry: confirm no Guildbook RPC during these operations. No traffic inspection available? Choose BLOCKED.'
  } else {
    foreach($id in @('storage_initial','verified_sign_in','local_capture','encrypted_file_a','restart_restore','offline_restore','signout_ui_clear','signout_files_preserved','account_b_isolated','stale_a_rejected','account_b_capture','account_b_new_namespace','account_a_restore','public_sync','no_guildbook_rpc')) {
      Add-Check $id 'NOT_VERIFIED' 'BLOCKED' 'PREREQUISITE_BLOCKED'
    }
  }
} catch {
  Add-Check 'launcher_runtime' 'AUTO' 'BLOCKED' 'EXCEPTION_WITHHELD'
} finally {
  try {
    $r=Write-AcceptanceReport -Checks @($checks.ToArray()) -Directory $ReportDirectory -TestMode 'REAL_WINDOWS_MANUAL_ACCEPTANCE' -BuildSha $head -ArtifactDigest $sha
    Write-Host "FINAL: $($r.Result)"
    Write-Host "Report: $($r.Path)"
    exit $(if($r.Result -eq 'PASS'){0}elseif($r.Result -eq 'FAIL'){1}else{2})
  } catch {
    Write-Host 'BLOCKED: report directory unavailable'
    exit 2
  }
}
