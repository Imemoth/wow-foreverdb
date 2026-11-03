Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'GuildbookAcceptance.Core.psm1') -Force
if (-not (Test-AcceptanceEnvironment).Pass) { throw 'Windows DPAPI required for synthetic suite' }
$tmp=Join-Path $env:TEMP ('guildbook-synthetic-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip=Join-Path $tmp 'synthetic.zip'
  $package=Join-Path $tmp 'package'
  New-Item -ItemType Directory -Path $package | Out-Null
  [IO.File]::WriteAllText((Join-Path $package 'ForeverDB.Companion.exe'),'synthetic placeholder; never execute')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($package,$zip)
  $sha=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  if (-not (Test-CompanionArtifact -ArchivePath $zip -CompanionDirectory $package -ExpectedArchiveSha $sha -SkipVersionCheckForSyntheticTest).Pass) {throw 'Synthetic package positive failed'}
  if ((Test-CompanionArtifact -ArchivePath $zip -CompanionDirectory $package -ExpectedArchiveSha ('0'*64) -SkipVersionCheckForSyntheticTest).Pass) {throw 'Wrong ZIP hash accepted'}
  $root=Join-Path $tmp 'guildbook'
  $a='a'*64; $b='b'*64; $inst='1'*64
  $dir=Join-Path (Join-Path $root $a) $inst
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $plain=[Text.Encoding]::UTF8.GetBytes('synthetic-fixture-only')
  $encrypted=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $target=Join-Path $dir 'snapshot.dat'
  [IO.File]::WriteAllText($target,[Convert]::ToBase64String($encrypted))
  [Array]::Clear($plain,0,$plain.Length)
  [Array]::Clear($encrypted,0,$encrypted.Length)
  $state=Get-GuildbookStoreState -Root $root
  if (-not $state.Pass -or $state.AccountCount -ne 1 -or $state.FileCount -ne 1) {throw 'Synthetic storage positive failed'}
  if (-not (Test-StorePreserved -Before $state -After (Get-GuildbookStoreState -Root $root))) {throw 'Preservation positive failed'}
  $dirB=Join-Path (Join-Path $root $b) $inst
  New-Item -ItemType Directory -Path $dirB -Force | Out-Null
  Copy-Item -LiteralPath $target -Destination (Join-Path $dirB 'snapshot.dat')
  $two=Get-GuildbookStoreState -Root $root
  if (-not (Test-SeparateAccountCreated -Before $state -After $two)) {throw 'Namespace positive failed'}
  if (Test-StorePreserved -Before $state -After $two) {throw 'New namespace falsely treated as unchanged'}
  [IO.File]::WriteAllText((Join-Path $dirB 'snapshot.dat'),'not-protected')
  if ((Get-GuildbookStoreState -Root $root).Pass) {throw 'Corrupt DPAPI accepted'}
  if ((Get-AcceptanceOutcome -Checks @(
    (New-AcceptanceCheck 'x' 'AUTO' 'PASS' 'OK'),
    (New-AcceptanceCheck 'y' 'NOT_VERIFIED' 'BLOCKED' 'NOT_TESTED'))) -ne 'BLOCKED') {throw 'BLOCKED aggregation failed'}
  if ((Get-AcceptanceOutcome -Checks @(
    (New-AcceptanceCheck 'x' 'AUTO' 'FAIL' 'BROKEN'),
    (New-AcceptanceCheck 'y' 'NOT_VERIFIED' 'BLOCKED' 'NOT_TESTED'))) -ne 'FAIL') {throw 'FAIL aggregation failed'}
  if ((Get-AcceptanceOutcome -Checks @((New-AcceptanceCheck 'x' 'AUTO' 'PASS' 'OK'))) -ne 'PASS') {throw 'PASS aggregation failed'}
  $report=Write-AcceptanceReport -Checks @((New-AcceptanceCheck 'fixture' 'AUTO' 'PASS' 'SYNTHETIC')) -Directory (Join-Path $tmp 'reports') -TestMode 'SYNTHETIC_WINDOWS_SELFTEST' -BuildSha 'test-fixture' -ArtifactDigest ('0'*64)
  $json=Get-Content -LiteralPath $report.Path -Raw | ConvertFrom-Json
  if ($json.result -ne 'PASS' -or $json.mode -ne 'SYNTHETIC_WINDOWS_SELFTEST' -or $json.checks[0].evidence -ne 'AUTO') {throw 'Report format invalid'}
  Write-Host 'SYNTHETIC_WINDOWS_SELFTEST: PASS (positive, corruption, hash, namespace, preservation, tri-state, report)'
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
