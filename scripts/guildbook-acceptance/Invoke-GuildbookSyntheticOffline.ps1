[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ArtifactZip,
    [Parameter(Mandatory=$true)][string]$CompanionDirectory,
    [string]$FixtureParent='C:\ForeverDB-Test\synthetic-fixtures',
    [string]$ReportDirectory='C:\ForeverDB-Test\acceptance-reports',
    [switch]$NonInteractive
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'GuildbookAcceptance.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'GuildbookSynthetic.Core.psm1') -Force
$head='b47606061e21173ac091916e100cd51988d7ba90'
$zipHash='109d5a768c33b47afdc4ced86b2c92783feafe94fec86009d6341cfef1d79ced'
$store=Join-Path $env:LOCALAPPDATA 'ForeverDB\guildbook'
$checks=New-Object 'System.Collections.Generic.List[object]'
function Record([string]$Id,[string]$Evidence,[string]$Status,[string]$Code) {
    $checks.Add((New-AcceptanceCheck -Id $Id -Evidence $Evidence -Status $Status -Code $Code))
    Write-Host ('[{0}] {1}: {2}' -f $Status,$Id,$Code)
}
function Ask([string]$Id,[string]$Instruction) {
    Write-Host ''
    Write-Host ('MANUAL: '+$Instruction) -ForegroundColor Cyan
    if ($NonInteractive) { Record $Id 'NOT_VERIFIED' 'BLOCKED' 'NONINTERACTIVE'; return 'BLOCKED' }
    do {
        $v=(Read-Host 'P=observed PASS / F=observed FAIL / B=not verified').Trim().ToUpperInvariant()
    } until ($v -in @('P','F','B'))
    $status=if($v -eq 'P'){'PASS'}elseif($v -eq 'F'){'FAIL'}else{'BLOCKED'}
    Record $Id $(if($status -eq 'BLOCKED'){'NOT_VERIFIED'}else{'MANUAL'}) $status $(if($status -eq 'PASS'){'USER_ATTESTED'}elseif($status -eq 'FAIL'){'USER_REPORTED_FAILURE'}else{'NOT_VERIFIED'})
    return $status
}
function Offline([string]$Id) {
    Write-Host ''
    Write-Host 'Disconnect Wi-Fi, Ethernet, VPN, tethering, proxies BEFORE manual Sync now.' -ForegroundColor Yellow
    if($NonInteractive){Record $Id 'NOT_VERIFIED' 'BLOCKED' 'NOT_CHECKED';return $false}
    [void](Read-Host 'Disconnect ALL internet routes, then press Enter to verify routes')
    try {
        if(-not (Get-Command Get-NetRoute -ErrorAction SilentlyContinue)) {throw 'No route inspection'}
        $interfaces=@(Get-NetIPInterface -ErrorAction Stop | Where-Object {$_.ConnectionState -eq 'Connected'})
        $routes=@(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object {$_.DestinationPrefix -in @('0.0.0.0/0','::/0')})
        foreach($route in $routes) {
            if(@($interfaces | Where-Object {$_.InterfaceIndex -eq $route.InterfaceIndex}).Count -gt 0) {
                throw 'Default route still active'
            }
        }
    } catch {
        Record $Id 'AUTO' 'BLOCKED' 'DEFAULT_ROUTE_OR_UNCERTAIN_NETWORK'
        Write-Host 'Do NOT press Sync now; the internet may be reachable.' -ForegroundColor Yellow
        return $false
    }
    Record $Id 'AUTO' 'PASS' 'NO_CONNECTED_DEFAULT_ROUTE'
    return $true
}
function Scan([string]$Id) {
    $s=Get-GuildbookStoreState -Root $store
    Record $Id 'AUTO' $(if($s.Pass){'PASS'}else{'FAIL'}) $s.Code
    return $s
}
function Has-SyntheticInstallation([object]$State,[string]$Id) {
    $bytes=[Text.Encoding]::UTF8.GetBytes($Id)
    $sha=[Security.Cryptography.SHA256]::Create()
    try {
        $hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
        foreach($k in $State.Inventory.Keys) {
            if($k.EndsWith('/'+$hash+'/snapshot.dat',[StringComparison]::Ordinal)) {return $true}
        }
        return $false
    } finally {
        $sha.Dispose()
        [Array]::Clear($bytes,0,$bytes.Length)
    }
}
Write-Host 'ForeverDB Guildbook / Offline synthetic Windows GUI exercise'
Write-Host 'Generator only writes new fictional files under a unique synthetic-fixtures directory.'
Write-Host 'The launcher NEVER starts Companion, changes networking, connects to APIs, or clicks Sync now.'
Write-Host 'Companion itself writes settings/credentials/DPAPI data in the current Windows profile.'
Write-Host 'Use Windows Sandbox or a NEW Windows test user; avoid your historical ForeverDB profile.'
Write-Host 'NEVER press Sync now online: the pinned Companion also attempts a public upload.'
try {
    $e=Test-AcceptanceEnvironment
    Record 'windows_dpapi' 'AUTO' $(if($e.Pass){'PASS'}else{'BLOCKED'}) $e.Code
    $a=Test-CompanionArtifact -ArchivePath $ArtifactZip -CompanionDirectory $CompanionDirectory -ExpectedArchiveSha $zipHash
    Record 'pinned_artifact' 'AUTO' $(if($a.Pass){'PASS'}else{'BLOCKED'}) $a.Code
    if(-not $e.Pass -or -not $a.Pass){throw 'Preflight'}
    $initial=Scan 'storage_initial'
    if(-not $initial.Pass){throw 'Unusable store'}
    if($initial.FileCount -ne 0){
        Record 'isolation' 'AUTO' 'BLOCKED' 'EXISTING_GUILDBOOK_DATA_USE_SEPARATE_WINDOWS_USER'
        throw 'Pre-existing user data'
    }
    Record 'isolation' 'AUTO' 'PASS' 'NO_PRIOR_GUILDBOOK_SNAPSHOTS'
    $fixture=New-GuildbookSyntheticFixture -OutputParent $FixtureParent
    Record 'synthetic_fixture_setup' 'AUTO' 'PASS' 'SCHEMA9_HEADER_ONLY'
    Write-Host ''
    Write-Host ('SYNTHETIC WOW ROOT: '+$fixture.WowRoot) -ForegroundColor Green
    Write-Host ('Companion EXE: '+(Join-Path $CompanionDirectory 'ForeverDB.Companion.exe'))
    $configured=Ask 'fixture_wow_root' 'Exit Companion fully via tray Exit. Open pinned EXE. Settings: set WoW root to SYNTHETIC WOW ROOT above, disable Auto Sync and Save settings; confirm Account lists installation. Do NOT press Sync now.'
    $aLogin=Ask 'account_a_verified' 'While ONLINE, sign in with an already confirmed test Account A; allow server-side registered verification. Never enter credentials into this script.'
    if($configured -ne 'PASS' -or $aLogin -ne 'PASS'){throw 'Setup not verified'}
    $fixture=Set-GuildbookSyntheticFixturePhase -FixtureRoot $fixture.Root -Phase A
    Record 'synthetic_a_written' 'AUTO' 'PASS' 'FRESH_SCHEMA9_GCP_RECORDS'
    if(-not (Offline 'offline_gate_a')){throw 'Cannot ensure offline'}
    $aCapture=Ask 'local_a_ui' 'STAY OFFLINE: click Status > Sync now ONCE. Public sync ERROR is expected. Verify Guildbook contains Synthetic Guild A and fake member.'
    $afterA=Scan 'storage_after_a'
    if($aCapture -eq 'PASS'){
        $new=$afterA.Pass -and $afterA.FileCount -gt $initial.FileCount -and (Test-StorePreserved -Before $initial -After $afterA -AllowAdditionalFiles) -and (Has-SyntheticInstallation -State $afterA -Id $fixture.Manifest.installation_id)
        Record 'a_dpapi_file_created' 'AUTO' $(if($new){'PASS'}else{'FAIL'}) 'NEW_SYNTHETIC_INSTALLATION_SNAPSHOT_EXPECTED'
    }else{Record 'a_dpapi_file_created' 'NOT_VERIFIED' 'BLOCKED' 'CAPTURE_NOT_VERIFIED'}
    if($aCapture -ne 'PASS'){throw 'A not verified'}
    Write-Host 'Reconnect internet now; keep Auto Sync OFF.' -ForegroundColor Yellow
    $signout=Ask 'signout_a_ui' 'ONLINE: sign out A, verify its private Guildbook roster disappears.'
    $afterOut=Scan 'storage_after_signout'
    if($signout -eq 'PASS'){
        Record 'a_files_preserved' 'AUTO' $(if(Test-StorePreserved -Before $afterA -After $afterOut){'PASS'}else{'FAIL'}) 'ENCRYPTED_SNAPSHOTS_UNCHANGED'
    }else{Record 'a_files_preserved' 'NOT_VERIFIED' 'BLOCKED' 'SIGNOUT_NOT_VERIFIED'}
    $bLogin=Ask 'account_b_verified' 'ONLINE: sign in with different, already confirmed test Account B. Verify no A Guildbook data appears. Do NOT press Sync now online.'
    if($bLogin -ne 'PASS'){throw 'B not verified'}
    if(-not (Offline 'offline_gate_b')){throw 'Cannot ensure offline B'}
    $replay=Ask 'stale_a_rejected' 'STAY OFFLINE: click Sync now while fixture STILL has old A capture. Verify that A does NOT appear for B. The public sync attempt will fail offline.'
    $afterReplay=Scan 'storage_after_replay'
    if($replay -eq 'PASS'){
        Record 'stale_a_no_write' 'AUTO' $(if(Test-StorePreserved -Before $afterOut -After $afterReplay){'PASS'}else{'FAIL'}) 'NO_STALE_ACCOUNT_SNAPSHOT'
    }else{Record 'stale_a_no_write' 'NOT_VERIFIED' 'BLOCKED' 'REPLAY_NOT_VERIFIED'}
    if($replay -ne 'PASS'){throw 'Replay not verified'}
    $fixture=Set-GuildbookSyntheticFixturePhase -FixtureRoot $fixture.Root -Phase B
    Record 'synthetic_b_written' 'AUTO' 'PASS' 'NEWER_SCHEMA9_GCP_RECORDS'
    $bCapture=Ask 'local_b_ui' 'STILL OFFLINE: click Sync now once more; verify ONLY Synthetic Guild B appears.'
    $afterB=Scan 'storage_after_b'
    if($bCapture -eq 'PASS'){
        $separate=(Test-SeparateAccountCreated -Before $afterOut -After $afterB) -and (Has-SyntheticInstallation -State $afterB -Id $fixture.Manifest.installation_id)
        Record 'b_account_namespace' 'AUTO' $(if($separate){'PASS'}else{'FAIL'}) 'NEW_HASHED_ACCOUNT_NAMESPACE_EXPECTED'
    }else{Record 'b_account_namespace' 'NOT_VERIFIED' 'BLOCKED' 'B_CAPTURE_NOT_VERIFIED'}
    Write-Host 'Reconnect internet now; keep Auto Sync OFF.' -ForegroundColor Yellow
    $returnA=Ask 'account_a_return' 'ONLINE: sign out B, sign back into A. Confirm ONLY Synthetic Guild A returns, without new capture.'
    [void](Ask 'restart_a' 'Exit Companion via tray Exit, restart it ONLINE, verify Guild A returns without Sync now.')
    if($returnA -eq 'PASS'){
        if(Offline 'offline_restart_gate'){
            [void](Ask 'offline_restart_a' 'FULLY Exit Companion; with internet STILL DISCONNECTED restart and confirm previously verified A Guildbook returns without Sync now.')
        }else{Record 'offline_restart_a' 'NOT_VERIFIED' 'BLOCKED' 'OFFLINE_NOT_CONFIRMED'}
    }else{Record 'offline_restart_a' 'NOT_VERIFIED' 'BLOCKED' 'A_NOT_VERIFIED'}
} catch {
    Record 'exercise_progress' 'NOT_VERIFIED' 'BLOCKED' 'STOPPED_SAFELY'
} finally {
    Record 'real_wow_addon_capture' 'NOT_VERIFIED' 'BLOCKED' 'GAME_NOT_YET_AVAILABLE'
    Record 'authorized_public_observation_sync' 'NOT_VERIFIED' 'BLOCKED' 'NO_LIVE_UPLOAD'
    Record 'runtime_no_guildbook_rpc' 'NOT_VERIFIED' 'BLOCKED' 'NO_ENDPOINT_TRACE'
    try {
        $r=Write-AcceptanceReport -Checks @($checks.ToArray()) -Directory $ReportDirectory -TestMode 'SYNTHETIC_OFFLINE_GUI_EXERCISE' -BuildSha $head -ArtifactDigest $zipHash
        Write-Host ''
        Write-Host ('FINAL ACCEPTANCE: '+$r.Result)
        Write-Host ('Secret-free JSON report: '+$r.Path)
        exit $(if($r.Result -eq 'FAIL'){1}else{2})
    } catch {
        Write-Host 'BLOCKED: unable to create report.'
        exit 2
    }
}
