Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'GuildbookAcceptance.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'GuildbookSynthetic.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'GuildbookResume.Core.psm1') -Force

# Validate both scripts without executing the interactive launcher.
foreach ($relative in @('Invoke-GuildbookSyntheticResume.ps1','GuildbookResume.Core.psm1')) {
    $scriptPath = Join-Path $PSScriptRoot $relative
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $scriptPath,[ref]$tokens,[ref]$parseErrors)
    if (@($parseErrors).Count -gt 0) {
        throw ('PowerShell source cannot parse: ' + $relative)
    }
}

function Expect([bool]$condition,[string]$message) {
    if (-not $condition) { throw ('Synthetic resumability check failed: ' + $message) }
}
function Expect-Throw([scriptblock]$action,[string]$message) {
    $didThrow = $false
    try { & $action | Out-Null } catch { $didThrow = $true }
    if (-not $didThrow) { throw ('Expected failure: ' + $message) }
}
function Make-DpapiFixture([string]$file,[string]$value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($value)
    $sealed = [Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    try {
        [IO.File]::WriteAllText($file,[Convert]::ToBase64String($sealed),[Text.Encoding]::ASCII)
    } finally {
        [Array]::Clear($bytes,0,$bytes.Length)
        [Array]::Clear($sealed,0,$sealed.Length)
    }
}
function HashIdentity([string]$value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant())
    } finally {
        $sha.Dispose()
        [Array]::Clear($bytes,0,$bytes.Length)
    }
}
Expect ((Test-AcceptanceEnvironment).Pass) 'CurrentUser DPAPI on Windows required'

$tmp = Join-Path $env:TEMP ('guildbook-resume-synthetic-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tmp) | Out-Null
try {
    $fixture = New-GuildbookSyntheticFixture -OutputParent (Join-Path $tmp 'synthetic-fixtures')
    $fixture = Set-GuildbookSyntheticFixturePhase -FixtureRoot $fixture.Root -Phase A
    $exeDirectory = Join-Path $tmp 'package'
    [IO.Directory]::CreateDirectory($exeDirectory) | Out-Null
    $exePath = Join-Path $exeDirectory 'ForeverDB.Companion.exe'
    [IO.File]::WriteAllText($exePath,'synthetic binary placeholder')
    $settingsPath = Join-Path $tmp 'settings.json'
    $settings = [ordered]@{ WowRoot=$fixture.WowRoot; AutoSync=$false }
    [IO.File]::WriteAllText($settingsPath,($settings | ConvertTo-Json),[Text.Encoding]::UTF8)
    $storeRoot = Join-Path $tmp 'guildbook'
    $digest = '1' * 64

    $context = Get-GuildbookResumeContext -FixtureRoot $fixture.Root -CompanionDirectory $exeDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest $digest
    Expect ($context.guildbook_file_count -eq 0) 'initial store empty'
    $state = New-GuildbookResumeState -Context $context
    Add-GuildbookResumeCheck -State $state -Check (New-AcceptanceCheck -Id 'account_a_verified' -Evidence 'MANUAL' -Status 'PASS' -Code 'USER_ATTESTED')
    $checkpoint = Get-GuildbookResumePath -FixtureRoot $fixture.Root
    Write-GuildbookResumeState -Path $checkpoint -State $state -CreateOnly
    Expect-Throw { Write-GuildbookResumeState -Path $checkpoint -State $state -CreateOnly } 'checkpoint may not be overwritten during Prepare'
    $loaded = Read-GuildbookResumeState -Path $checkpoint
    Expect ((Assert-GuildbookResumeContext -Saved $loaded.context -Current $context)) 'roundtrip context'
    Expect ($loaded.stage -eq 'AwaitOfflineA') 'correct resume stage'
    Expect (@($loaded.checks).Count -eq 1) 'manual evidence persisted'
    Expect-Throw {
        Add-GuildbookResumeCheck -State $loaded -Check (New-AcceptanceCheck -Id 'account_a_verified' -Evidence 'MANUAL' -Status 'PASS' -Code 'USER_ATTESTED')
    } 'duplicate evidence refused'
    Expect-Throw {
        Add-GuildbookResumeCheck -State $loaded -Check (New-AcceptanceCheck -Id 'not_done' -Evidence 'NOT_VERIFIED' -Status 'BLOCKED' -Code 'NOT_VERIFIED')
    } 'unverified evidence cannot be checkpointed'

    $changedMachine = Read-GuildbookResumeState -Path $checkpoint
    $changedMachine.context.machine = 'ANOTHER-COMPUTER'
    Expect-Throw { Assert-GuildbookResumeContext -Saved $changedMachine.context -Current $context } 'machine mismatch refused'
    $changedSid = Read-GuildbookResumeState -Path $checkpoint
    $changedSid.context.windows_sid = 'S-1-0-0'
    Expect-Throw { Assert-GuildbookResumeContext -Saved $changedSid.context -Current $context } 'Windows identity mismatch refused'

    [IO.File]::WriteAllText($exePath,'changed synthetic binary')
    $changedBuild = Get-GuildbookResumeContext -FixtureRoot $fixture.Root -CompanionDirectory $exeDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest $digest
    Expect-Throw { Assert-GuildbookResumeContext -Saved $context -Current $changedBuild } 'changed executable refused'
    [IO.File]::WriteAllText($exePath,'synthetic binary placeholder')
    $changedArtifact = Get-GuildbookResumeContext -FixtureRoot $fixture.Root -CompanionDirectory $exeDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest ('2'*64)
    Expect-Throw { Assert-GuildbookResumeContext -Saved $context -Current $changedArtifact } 'changed archive digest refused'

    $settings.AutoSync = $true
    [IO.File]::WriteAllText($settingsPath,($settings | ConvertTo-Json),[Text.Encoding]::UTF8)
    Expect-Throw {
        Get-GuildbookResumeContext -FixtureRoot $fixture.Root -CompanionDirectory $exeDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest $digest
    } 'Auto Sync ON must block'
    $settings.AutoSync = $false
    [IO.File]::WriteAllText($settingsPath,($settings | ConvertTo-Json),[Text.Encoding]::UTF8)

    $accountA = HashIdentity 'synthetic-a'
    $accountB = HashIdentity 'synthetic-b'
    $installation = HashIdentity ([string]$fixture.Manifest.installation_id)
    $dirA = Join-Path (Join-Path $storeRoot $accountA) $installation
    $dirB = Join-Path (Join-Path $storeRoot $accountB) $installation
    [IO.Directory]::CreateDirectory($dirA) | Out-Null
    Make-DpapiFixture (Join-Path $dirA 'snapshot.dat') 'synthetic-a-only'
    $contextA = Get-GuildbookResumeContext -FixtureRoot $fixture.Root -CompanionDirectory $exeDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest $digest
    Expect-Throw { Assert-GuildbookResumeContext -Saved $context -Current $contextA } 'store creation invalidates prior checkpoint'
    Expect (Test-SyntheticAccountStore -GuildbookStore $storeRoot -InstallationId $fixture.Manifest.installation_id -ExpectedAccountCount 1) 'A capture has expected namespace'
    Expect (-not (Test-SyntheticAccountStore -GuildbookStore $storeRoot -InstallationId 'wrong-installation' -ExpectedAccountCount 1)) 'wrong installation must not count'

    [IO.Directory]::CreateDirectory($dirB) | Out-Null
    Make-DpapiFixture (Join-Path $dirB 'snapshot.dat') 'synthetic-b-only'
    $contextB = Get-GuildbookResumeContext -FixtureRoot $fixture.Root -CompanionDirectory $exeDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest $digest
    Expect (Test-SyntheticAccountStore -GuildbookStore $storeRoot -InstallationId $fixture.Manifest.installation_id -ExpectedAccountCount 2) 'B must create a separate namespace'
    Expect (Test-PreservedSyntheticStoreFiles -Before $contextA -After $contextB) 'A encrypted snapshots preserved after B'
    Make-DpapiFixture (Join-Path $dirA 'snapshot.dat') 'synthetic-a-modified'
    $modifiedA = Get-GuildbookResumeContext -FixtureRoot $fixture.Root -CompanionDirectory $exeDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest $digest
    Expect (-not (Test-PreservedSyntheticStoreFiles -Before $contextA -After $modifiedA)) 'changed A snapshot rejected'

    $fakeInterface = @([pscustomobject]@{ ConnectionState='Connected'; InterfaceIndex=7 })
    $defaultRoute = @([pscustomobject]@{ DestinationPrefix='0.0.0.0/0'; InterfaceIndex=7 })
    $localRoute = @([pscustomobject]@{ DestinationPrefix='192.168.5.0/24'; InterfaceIndex=7 })
    Expect (-not (Test-OfflineRouteSafety -Interfaces $fakeInterface -Routes $defaultRoute)) 'connected internet route must block'
    Expect (Test-OfflineRouteSafety -Interfaces $fakeInterface -Routes $localRoute) 'non-default route itself is not a default route'
    Expect (-not (Test-OfflineRouteSafety -Interfaces $null -Routes $localRoute)) 'unknown routes must block'

    $original = [IO.File]::ReadAllText($checkpoint,[Text.Encoding]::ASCII)
    $position = [int]($original.Length / 2)
    $letter = if ($original[$position] -ceq 'A') { 'B' } else { 'A' }
    $tampered = $original.Substring(0,$position) + $letter + $original.Substring($position+1)
    [IO.File]::WriteAllText($checkpoint,$tampered,[Text.Encoding]::ASCII)
    Expect-Throw { Read-GuildbookResumeState -Path $checkpoint } 'DPAPI tampered checkpoint refused'
    [IO.File]::WriteAllText($checkpoint,$original,[Text.Encoding]::ASCII)

    $fixtureActive = $fixture.ActivePath
    [IO.File]::AppendAllText($fixtureActive,'modified')
    Expect-Throw { Get-SyntheticManifest -FixtureRoot $fixture.Root } 'modified phase A fixture refused'

    $reports = Join-Path $tmp 'reports'
    $check = New-AcceptanceCheck -Id 'synthetic_probe' -Evidence 'AUTO' -Status 'PASS' -Code 'OK'
    $report = Write-AcceptanceReport -Checks @($check) -Directory $reports -TestMode 'SYNTHETIC_RESUME_SELFTEST' -BuildSha 'synthetic' -ArtifactDigest $digest
    $reportContents = [IO.File]::ReadAllText($report.Path)
    Expect (-not $reportContents.Contains($fixture.Root)) 'no private checkpoint/fixture path in report'
    Expect (-not $reportContents.Contains($accountA)) 'no account hash in report'
    Expect (-not $reportContents.Contains('synthetic-a-only')) 'no plaintext in report'
    Write-Host 'SYNTHETIC_RESUME_SELFTEST: PASS (DPAPI, tamper, host/SID, artifact/exe, settings, fixture, store, route, report)'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
