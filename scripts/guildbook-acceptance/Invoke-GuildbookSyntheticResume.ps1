[CmdletBinding()]
param(
    [ValidateSet('Prepare','Resume','Status')][string]$Action = 'Status',
    [string]$ArtifactZip = 'C:\ForeverDB-Test\ForeverDB-Companion-win-x64.zip',
    [string]$CompanionDirectory = 'C:\ForeverDB-Test',
    [string]$FixtureParent = 'C:\ForeverDB-Test\synthetic-fixtures',
    [string]$FixtureRoot,
    [string]$ReportDirectory = 'C:\ForeverDB-Test\acceptance-reports',
    [switch]$DeferOffline,
    [switch]$NonInteractive
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'GuildbookAcceptance.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'GuildbookSynthetic.Core.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'GuildbookResume.Core.psm1') -Force

$sourceHead = 'b47606061e21173ac091916e100cd51988d7ba90'
$zipDigest = '109d5a768c33b47afdc4ced86b2c92783feafe94fec86009d6341cfef1d79ced'
$settingsPath = Join-Path $env:LOCALAPPDATA 'ForeverDB\settings.json'
$storeRoot = Join-Path $env:LOCALAPPDATA 'ForeverDB\guildbook'
$temporaryChecks = New-Object 'System.Collections.Generic.List[object]'
$state = $null
$validated = $false
$stopped = $false
$checkpointPath = $null

function Note([string]$id,[string]$evidence,[string]$status,[string]$code) {
    $check = New-AcceptanceCheck -Id $id -Evidence $evidence -Status $status -Code $code
    $temporaryChecks.Add($check)
    Write-Host ('[{0}] {1}: {2}' -f $status,$id,$code)
}
function Ask([string]$label,[string]$instruction) {
    Write-Host ''
    Write-Host ('MANUAL: ' + $instruction) -ForegroundColor Cyan
    if ($NonInteractive) { return 'BLOCKED' }
    do {
        $value = (Read-Host 'P=observed PASS / F=observed FAIL / B=defer').Trim().ToUpperInvariant()
    } until ($value -in @('P','F','B'))
    if ($value -eq 'P') { return 'PASS' }
    if ($value -eq 'F') { return 'FAIL' }
    return 'BLOCKED'
}
function Evidence([string]$id,[string]$kind,[string]$code) {
    return (New-AcceptanceCheck -Id $id -Evidence $kind -Status 'PASS' -Code $code)
}
function CurrentContext {
    return (Get-GuildbookResumeContext -FixtureRoot $FixtureRoot -CompanionDirectory $CompanionDirectory -SettingsPath $settingsPath -GuildbookStore $storeRoot -ArtifactDigest $zipDigest)
}
function Commit([string]$next,[object[]]$positive) {
    foreach ($item in $positive) { Add-GuildbookResumeCheck -State $state -Check $item }
    $state.stage = $next
    $state.context = CurrentContext
    Write-GuildbookResumeState -Path $checkpointPath -State $state
    Write-Host ('Checkpoint saved: ' + $next) -ForegroundColor Green
}
function Halt([string]$id,[string]$status,[string]$code) {
    Note $id $(if($status -eq 'FAIL'){'MANUAL'}else{'NOT_VERIFIED'}) $status $code
    if ($status -eq 'FAIL' -and $validated) {
        $failed = New-AcceptanceCheck -Id $id -Evidence 'MANUAL' -Status 'FAIL' -Code $code
        Add-GuildbookResumeCheck -State $state -Check $failed
        $state.context = CurrentContext
        Write-GuildbookResumeState -Path $checkpointPath -State $state
    }
    $script:stopped = $true
}
function StopIfNotPass([string]$id,[string]$choice) {
    if ($choice -eq 'PASS') { return $false }
    Halt $id $choice $(if($choice -eq 'FAIL'){'USER_REPORTED_FAILURE'}else{'MANUAL_STEP_DEFERRED'})
    return $true
}
function RequireOffline([string]$id) {
    if ($DeferOffline -or $NonInteractive) {
        Note $id 'NOT_VERIFIED' 'BLOCKED' 'DEFERRED_UNTIL_PHYSICAL_ACCESS'
        return $false
    }
    Write-Host ''
    Write-Host 'WARNING: never disconnect a network interface on a remote-controlled computer.' -ForegroundColor Yellow
    Write-Host 'Only proceed PHYSICALLY at the PC; disconnect Wi-Fi, Ethernet, VPN and tethering.' -ForegroundColor Yellow
    $word = (Read-Host 'When physically offline type OFFLINE; anything else cancels').Trim()
    if ($word -cne 'OFFLINE') {
        Note $id 'NOT_VERIFIED' 'BLOCKED' 'OFFLINE_NOT_CONFIRMED'
        return $false
    }
    try {
        if ($env:SESSIONNAME -like 'RDP-*') { throw 'Remote desktop session' }
        if (-not (Get-Command Get-NetRoute -ErrorAction SilentlyContinue)) {
            throw 'Network inspection unavailable'
        }
        $connected = @(Get-NetIPInterface -ErrorAction Stop | Where-Object { $_.ConnectionState -eq 'Connected' })
        $defaults = @(Get-NetRoute -PolicyStore ActiveStore -ErrorAction Stop | Where-Object {
            $_.DestinationPrefix -in @('0.0.0.0/0','::/0')
        })
        foreach ($route in $defaults) {
            if (@($connected | Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex }).Count -gt 0) {
                throw 'A connected default route exists'
            }
        }
    } catch {
        Note $id 'NOT_VERIFIED' 'BLOCKED' 'ROUTE_PRESENT_OR_UNVERIFIABLE'
        Write-Host 'DO NOT click Sync now. No network changes were made.' -ForegroundColor Yellow
        return $false
    }
    Note $id 'AUTO' 'PASS' 'NO_CONNECTED_DEFAULT_ROUTE_NOW'
    Write-Host 'Connectivity can still exist through unusual routes. Keep the machine physically offline.' -ForegroundColor Yellow
    return $true
}
function RequireUnchangedStore([string]$id) {
    $current = CurrentContext
    if ([string]$current.guildbook_store_sha256 -cne [string]$state.context.guildbook_store_sha256 -or
        $current.guildbook_file_count -ne $state.context.guildbook_file_count -or
        $current.guildbook_account_count -ne $state.context.guildbook_account_count) {
        Note $id 'AUTO' 'FAIL' 'ENCRYPTED_STORE_CHANGED'
        $script:stopped = $true
        return $false
    }
    Note $id 'AUTO' 'PASS' 'ENCRYPTED_STORE_UNCHANGED'
    return $true
}
function FindFixture {
    if (-not [string]::IsNullOrWhiteSpace($FixtureRoot)) {
        return (Get-SyntheticManifest -FixtureRoot $FixtureRoot)
    }
    if (-not [IO.Directory]::Exists($FixtureParent)) { throw 'No synthetic fixture directory exists' }
    $matches = @()
    foreach ($folder in @(Get-ChildItem -LiteralPath $FixtureParent -Directory -Filter 'synthetic-*' -ErrorAction Stop)) {
        try {
            $f = Get-SyntheticManifest -FixtureRoot $folder.FullName
            $checkpoint = Get-GuildbookResumePath -FixtureRoot $f.Root
            if ($Action -eq 'Prepare' -and $f.Manifest.phase -eq 'A' -and -not [IO.File]::Exists($checkpoint)) {
                $matches += $f
            }
            if ($Action -ne 'Prepare' -and [IO.File]::Exists($checkpoint)) {
                $matches += $f
            }
        } catch {
            # Ignore non-matching or incomplete synthetic fixture directories.
        }
    }
    if ($matches.Count -ne 1) { throw 'Specify -FixtureRoot; zero or multiple eligible fixtures' }
    return $matches[0]
}

Write-Host 'ForeverDB Guildbook - resumable synthetic Windows acceptance'
Write-Host 'No programmatic upload, network disconnection, authentication or Companion launch.'
Write-Host 'Resume proof is sealed with Windows DPAPI CurrentUser; real acceptance remains BLOCKED.'

try {
    $environment = Test-AcceptanceEnvironment
    Note 'windows_dpapi' 'AUTO' $(if($environment.Pass){'PASS'}else{'BLOCKED'}) $environment.Code
    $artifact = Test-CompanionArtifact -ArchivePath $ArtifactZip -CompanionDirectory $CompanionDirectory -ExpectedArchiveSha $zipDigest
    Note 'pinned_artifact' 'AUTO' $(if($artifact.Pass){'PASS'}else{'BLOCKED'}) $artifact.Code
    if (-not $environment.Pass -or -not $artifact.Pass) {
        throw 'Pinned prerequisites unavailable'
    }

    $fixture = FindFixture
    $FixtureRoot = $fixture.Root
    $checkpointPath = Get-GuildbookResumePath -FixtureRoot $FixtureRoot
    Write-Host ('Synthetic WoW root: ' + $fixture.WowRoot)
    if ($Action -eq 'Prepare') {
        if ([IO.File]::Exists($checkpointPath)) { throw 'Checkpoint exists; use Resume' }
        if ($fixture.Manifest.phase -cne 'A') { throw 'Existing fixture must already be in phase A' }
        $context = CurrentContext
        if ($context.guildbook_file_count -ne 0) {
            throw 'Existing Guildbook data cannot be auto-imported as evidence'
        }
        $confirmed = Ask 'setup_confirmation' 'Confirm Companion Settings targets the synthetic root, Auto Sync is disabled, and account A shows a currently server-verified Registered sign-in. Do NOT click Sync now.'
        if (StopIfNotPass 'setup_confirmation' $confirmed) { throw 'Setup not confirmed' }
        $state = New-GuildbookResumeState -Context $context
        Add-GuildbookResumeCheck -State $state -Check (Evidence 'fixture_setup' 'AUTO' 'PHASE_A_VALIDATED')
        Add-GuildbookResumeCheck -State $state -Check (Evidence 'account_a_verified' 'MANUAL' 'USER_ATTESTED')
        Write-GuildbookResumeState -Path $checkpointPath -State $state -CreateOnly
        $validated = $true
        Write-Host 'PREPARED: existing phase A retained. No upload or offline test initiated.' -ForegroundColor Green
        Write-Host ('Checkpoint location (keep private): ' + $checkpointPath)
    } else {
        $state = Read-GuildbookResumeState -Path $checkpointPath
        $context = CurrentContext
        [void](Assert-GuildbookResumeContext -Saved $state.context -Current $context)
        $validated = $true
        if (@($state.checks | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) {
            throw 'Failed prior check cannot be reset by Resume'
        }
        Write-Host ('Verified resume stage: ' + $state.stage) -ForegroundColor Green
        Write-Host ('Completed verified checks: ' + @($state.checks).Count)
        if ($Action -eq 'Status') {
            Write-Host 'STATUS ONLY: no UI step initiated.'
        } else {
            while (-not $stopped) {
                $stage = [string]$state.stage
                switch ($stage) {
                    'AwaitOfflineA' {
                        if ($DeferOffline) {
                            Note 'offline_gate_a' 'NOT_VERIFIED' 'BLOCKED' 'DEFERRED_UNTIL_PHYSICAL_ACCESS'
                            $stopped = $true; break
                        }
                        $confirmation = Ask 'account_a_current' 'While still online, confirm A is CURRENTLY signed in/verified and Auto Sync is OFF. Do not click Sync now online.'
                        if (StopIfNotPass 'account_a_current' $confirmation) { break }
                        if (-not (RequireOffline 'offline_gate_a')) { $stopped = $true; break }
                        $choice = Ask 'local_a_ui' 'STAY OFFLINE. Click Status > Sync now ONCE. Public sync may fail; confirm Synthetic Guild A is visible.'
                        if (StopIfNotPass 'local_a_ui' $choice) { break }
                        $after = CurrentContext
                        if ($after.guildbook_file_count -le $state.context.guildbook_file_count -or
                            $after.guildbook_account_count -ne 1) {
                            Note 'a_dpapi_file_created' 'AUTO' 'FAIL' 'EXPECTED_NEW_ACCOUNT_SNAPSHOT_MISSING'
                            $stopped = $true; break
                        }
                        Commit 'AwaitSignoutA' @(
                            (Evidence 'local_a_ui' 'MANUAL' 'USER_ATTESTED'),
                            (Evidence 'a_dpapi_file_created' 'AUTO' 'DPAPI_FILE_OBSERVED')
                        )
                    }
                    'AwaitSignoutA' {
                        $choice = Ask 'signout_a_ui' 'Reconnect the network if needed. Sign out A; verify Guildbook UI clears. Do NOT use Sync now.'
                        if (StopIfNotPass 'signout_a_ui' $choice) { break }
                        if (-not (RequireUnchangedStore 'a_files_preserved')) { break }
                        Commit 'AwaitSigninB' @(
                            (Evidence 'signout_a_ui' 'MANUAL' 'USER_ATTESTED'),
                            (Evidence 'a_files_preserved' 'AUTO' 'SNAPSHOT_UNCHANGED')
                        )
                    }
                    'AwaitSigninB' {
                        $choice = Ask 'account_b_verified' 'ONLINE: sign in with a DIFFERENT verified test account B. Confirm A roster is absent; Auto Sync stays OFF.'
                        if (StopIfNotPass 'account_b_verified' $choice) { break }
                        if (-not (RequireUnchangedStore 'a_files_after_b_signin')) { break }
                        Commit 'AwaitOfflineBReplay' @(
                            (Evidence 'account_b_verified' 'MANUAL' 'USER_ATTESTED')
                        )
                    }
                    'AwaitOfflineBReplay' {
                        if (-not (RequireOffline 'offline_gate_b_replay')) { $stopped = $true; break }
                        $choice = Ask 'stale_a_rejected' 'STAY OFFLINE: fixture still has A. Click Sync now ONCE; verify A does not appear under account B.'
                        if (StopIfNotPass 'stale_a_rejected' $choice) { break }
                        if (-not (RequireUnchangedStore 'stale_a_no_write')) { break }
                        Commit 'AwaitOfflineBPhase' @(
                            (Evidence 'stale_a_rejected' 'MANUAL' 'USER_ATTESTED'),
                            (Evidence 'stale_a_no_write' 'AUTO' 'NO_STALE_WRITE')
                        )
                    }
                    'AwaitOfflineBPhase' {
                        if (-not (RequireOffline 'offline_gate_b_fixture')) { $stopped = $true; break }
                        $fixture = Set-GuildbookSyntheticFixturePhase -FixtureRoot $FixtureRoot -Phase B
                        Commit 'AwaitBCaptureUI' @(
                            (Evidence 'synthetic_b_written' 'AUTO' 'NEWER_SCHEMA9_GCP')
                        )
                        Write-Host 'Synthetic B is staged. Do not click Sync now until the next offline gate.' -ForegroundColor Yellow
                    }
                    'AwaitBCaptureUI' {
                        if (-not (RequireOffline 'offline_gate_b_capture')) { $stopped = $true; break }
                        $choice = Ask 'local_b_ui' 'STAY OFFLINE: click Sync now ONCE and confirm ONLY Synthetic Guild B appears.'
                        if (StopIfNotPass 'local_b_ui' $choice) { break }
                        $after = CurrentContext
                        if ($after.guildbook_account_count -ne ($state.context.guildbook_account_count + 1) -or
                            $after.guildbook_file_count -le $state.context.guildbook_file_count) {
                            Note 'b_account_namespace' 'AUTO' 'FAIL' 'NEW_ACCOUNT_NAMESPACE_NOT_OBSERVED'
                            $stopped = $true; break
                        }
                        Commit 'AwaitReturnA' @(
                            (Evidence 'local_b_ui' 'MANUAL' 'USER_ATTESTED'),
                            (Evidence 'b_account_namespace' 'AUTO' 'SECOND_ACCOUNT_DIRECTORY')
                        )
                    }
                    'AwaitReturnA' {
                        $choice = Ask 'account_a_return' 'Reconnect network. Sign out B; sign into A. Confirm only Synthetic Guild A returns with no new capture.'
                        if (StopIfNotPass 'account_a_return' $choice) { break }
                        if (-not (RequireUnchangedStore 'a_return_store')) { break }
                        Commit 'AwaitRestartA' @((Evidence 'account_a_return' 'MANUAL' 'USER_ATTESTED'))
                    }
                    'AwaitRestartA' {
                        $choice = Ask 'restart_a' 'Exit Companion via tray Exit, restart same executable ONLINE, verify A restores without Sync now.'
                        if (StopIfNotPass 'restart_a' $choice) { break }
                        if (-not (RequireUnchangedStore 'restart_store')) { break }
                        Commit 'AwaitOfflineRestartA' @((Evidence 'restart_a' 'MANUAL' 'USER_ATTESTED'))
                    }
                    'AwaitOfflineRestartA' {
                        if (-not (RequireOffline 'offline_restart_gate')) { $stopped = $true; break }
                        $choice = Ask 'offline_restart_a' 'STAY OFFLINE. Exit via tray Exit, restart, confirm A restores WITHOUT clicking Sync now.'
                        if (StopIfNotPass 'offline_restart_a' $choice) { break }
                        if (-not (RequireUnchangedStore 'offline_restart_store')) { break }
                        Commit 'SyntheticComplete' @((Evidence 'offline_restart_a' 'MANUAL' 'USER_ATTESTED'))
                    }
                    'SyntheticComplete' {
                        Write-Host 'Synthetic UI flow completed; full live acceptance still BLOCKED.' -ForegroundColor Green
                        $stopped = $true
                    }
                    default {
                        throw 'Unexpected checkpoint stage'
                    }
                }
            }
        }
    }
} catch {
    Note 'resume_safety_gate' 'NOT_VERIFIED' 'BLOCKED' 'CONTEXT_OR_PROGRESS_UNVERIFIED'
    Write-Host 'BLOCKED: cannot continue safely; no existing user files were removed.' -ForegroundColor Yellow
} finally {
    Note 'real_wow_addon_capture' 'NOT_VERIFIED' 'BLOCKED' 'GAME_NOT_YET_TESTED'
    Note 'authorized_public_observation_sync' 'NOT_VERIFIED' 'BLOCKED' 'NO_PRODUCTION_UPLOAD'
    Note 'runtime_no_guildbook_rpc' 'NOT_VERIFIED' 'BLOCKED' 'NO_ENDPOINT_TRACE'
    try {
        $persisted = if ($validated -and $null -ne $state) { @($state.checks) } else { @() }
        $all = @($persisted) + @($temporaryChecks.ToArray())
        $result = Write-AcceptanceReport -Checks $all -Directory $ReportDirectory -TestMode 'SYNTHETIC_OFFLINE_GUI_RESUMABLE' -BuildSha $sourceHead -ArtifactDigest $zipDigest
        Write-Host ('FINAL ACCEPTANCE: ' + $result.Result)
        Write-Host ('Secret-free JSON report: ' + $result.Path)
        exit $(if ($result.Result -eq 'FAIL') {1} else {2})
    } catch {
        Write-Host 'BLOCKED: unable to write acceptance report.'
        exit 2
    }
}
