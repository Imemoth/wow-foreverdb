Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'GuildbookSynthetic.Core.psm1') -Force
# Parse all PowerShell entrypoints without running them. A script with syntax
# errors must never be handed to a user even when fixture generation itself passes.
foreach($name in @(
    'GuildbookAcceptance.Core.psm1',
    'GuildbookSynthetic.Core.psm1',
    'Invoke-GuildbookAcceptance.ps1',
    'Invoke-GuildbookSyntheticOffline.ps1',
    'Test-GuildbookAcceptance.Synthetic.ps1',
    'Test-GuildbookSyntheticFixture.ps1'
)) {
    $tokens=$null
    $parseErrors=$null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$parseErrors)
    if(@($parseErrors).Count -ne 0) {throw ('PowerShell syntax invalid in '+$name)}
}
$tmp=Join-Path $env:TEMP ('foreverdb-synthetic-tests-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($tmp) | Out-Null
try {
    $parent=Join-Path $tmp 'synthetic-fixtures'
    $sentinel=Join-Path $tmp 'do-not-touch.txt'
    [IO.File]::WriteAllText($sentinel,'never modified')
    $fixture=New-GuildbookSyntheticFixture -OutputParent $parent
    if($fixture.Manifest.phase -ne 'Setup'){throw 'Setup stage missing'}
    $head=[IO.File]::ReadAllText($fixture.ActivePath)
    if($head -notmatch '^ForeverDB_Export = "H\|9\|' -or $head -match 'G\|'){throw 'Header-only fixture invalid'}
    $same=Get-SyntheticManifest -FixtureRoot $fixture.Root
    if($same.Manifest.digest -ne $fixture.Manifest.digest){throw 'Fresh fixture mismatch'}
    $fixture=Set-GuildbookSyntheticFixturePhase -FixtureRoot $fixture.Root -Phase A
    $a=[IO.File]::ReadAllText($fixture.ActivePath)
    if($a -notmatch 'G\|guild-a\|Synthetic Guild A' -or $a -notmatch '\\nC\|' -or $a -notmatch '\\nP\|' -or $a -match 'S\|'){
        throw 'A parser contract incorrect'
    }
    $unchanged=Set-GuildbookSyntheticFixturePhase -FixtureRoot $fixture.Root -Phase A
    if($unchanged.Manifest.digest -ne $fixture.Manifest.digest){throw 'A retry changed fixture'}
    $at=[long]$fixture.Manifest.last_capture_at
    $fixture=Set-GuildbookSyntheticFixturePhase -FixtureRoot $fixture.Root -Phase B
    $b=[IO.File]::ReadAllText($fixture.ActivePath)
    if($b -notmatch 'G\|guild-b\|Synthetic Guild B' -or $b -match 'Synthetic Guild A' -or
        [long]$fixture.Manifest.last_capture_at -le $at){throw 'B stage contract incorrect'}
    $failed=$false
    try{Set-GuildbookSyntheticFixturePhase -FixtureRoot $fixture.Root -Phase A | Out-Null}catch{$failed=$true}
    if(-not $failed){throw 'Fixture allowed backwards phase'}
    $outside=Join-Path $tmp 'synthetic-fixtures-fake'
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $failed=$false
    try{New-GuildbookSyntheticFixture -OutputParent $outside | Out-Null}catch{$failed=$true}
    if(-not $failed){throw 'Unsafe parent accepted'}
    $bad=Join-Path $tmp 'corrupt-fixture'
    # A new fixture is used for tamper testing so the validated A/B fixture
    # still exists for the dotnet parser test to consume.
    $bad=New-GuildbookSyntheticFixture -OutputParent $parent
    [IO.File]::AppendAllText($bad.ActivePath,'tampered')
    $failed=$false
    try{Set-GuildbookSyntheticFixturePhase -FixtureRoot $bad.Root -Phase A | Out-Null}catch{$failed=$true}
    if(-not $failed){throw 'Modified synthetic SavedVariables overwritten'}
    if([IO.File]::ReadAllText($sentinel) -cne 'never modified'){throw 'External file modified'}
    Write-Host 'SYNTHETIC FIXTURE TESTS: PASS (safe create, header, GCP, A/B freshness, idempotence, tampering, no external writes)'
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
