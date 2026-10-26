Set-StrictMode -Version Latest

# Resume state is DPAPI CurrentUser sealed, NOT a public acceptance report.
# It may contain local paths, the Windows SID, and hashes of encrypted stores.
# Never print its contents or attach it to an issue/PR.
$script:ResumeEntropy = [Text.Encoding]::UTF8.GetBytes('ForeverDB-Guildbook-Acceptance-Resume-v1')
$script:ResumeStages = @(
    'AwaitOfflineA',
    'AwaitSignoutA',
    'AwaitSigninB',
    'AwaitOfflineBReplay',
    'AwaitOfflineBPhase',
    'AwaitBCaptureUI',
    'AwaitReturnA',
    'AwaitRestartA',
    'AwaitOfflineRestartA',
    'SyntheticComplete'
)

function Get-GuildbookResumePath {
    param([Parameter(Mandatory=$true)][string]$FixtureRoot)
    $fixture = Get-SyntheticManifest -FixtureRoot $FixtureRoot
    return (Join-Path $fixture.Root '.guildbook-acceptance-resume.dpapi')
}

function Get-GuildbookResumeContext {
    param(
        [Parameter(Mandatory=$true)][string]$FixtureRoot,
        [Parameter(Mandatory=$true)][string]$CompanionDirectory,
        [Parameter(Mandatory=$true)][string]$SettingsPath,
        [Parameter(Mandatory=$true)][string]$GuildbookStore,
        [Parameter(Mandatory=$true)][string]$ArtifactDigest
    )
    $fixture = Get-SyntheticManifest -FixtureRoot $FixtureRoot
    $exe = Join-Path $CompanionDirectory 'ForeverDB.Companion.exe'
    if (-not [IO.File]::Exists($exe) -or -not [IO.File]::Exists($SettingsPath)) {
        throw 'Companion executable or configuration missing'
    }
    $settings = Get-Content -LiteralPath $SettingsPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($settings.AutoSync -ne $false -or [string]::IsNullOrWhiteSpace([string]$settings.WowRoot)) {
        throw 'Auto Sync must be disabled and synthetic WoW root configured'
    }
    $configuredRoot = [IO.Path]::GetFullPath([string]$settings.WowRoot).TrimEnd('\','/')
    $requiredRoot = [IO.Path]::GetFullPath($fixture.WowRoot).TrimEnd('\','/')
    if (-not $configuredRoot.Equals($requiredRoot,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Companion does not target the exact synthetic WoW root'
    }
    $store = Get-GuildbookStoreState -Root $GuildbookStore
    if (-not $store.Pass) {
        throw 'Local Guildbook store cannot be safely inspected or DPAPI-opened'
    }
    $combined = New-Object Text.StringBuilder
    foreach ($name in @($store.Inventory.Keys | Sort-Object -CaseSensitive)) {
        [void]$combined.Append($name)
        [void]$combined.Append('=')
        [void]$combined.Append($store.Inventory[$name])
        [void]$combined.Append([char]10)
    }
    $combinedBytes = [Text.Encoding]::UTF8.GetBytes($combined.ToString())
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $storeDigest = [BitConverter]::ToString($sha.ComputeHash($combinedBytes)).Replace('-','')
    } finally {
        $sha.Dispose()
        [Array]::Clear($combinedBytes,0,$combinedBytes.Length)
    }
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    return [pscustomobject]@{
        machine = [Environment]::MachineName
        windows_sid = $sid
        fixture_root = [IO.Path]::GetFullPath($fixture.Root).TrimEnd('\','/')
        fixture_phase = [string]$fixture.Manifest.phase
        fixture_digest = [string]$fixture.Manifest.digest
        installation_id = [string]$fixture.Manifest.installation_id
        artifact_sha256 = $ArtifactDigest.ToUpperInvariant()
        executable_sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256 -ErrorAction Stop).Hash
        settings_sha256 = (Get-FileHash -LiteralPath $SettingsPath -Algorithm SHA256 -ErrorAction Stop).Hash
        guildbook_store_sha256 = $storeDigest
        guildbook_file_count = [int]$store.FileCount
        guildbook_account_count = [int]$store.AccountCount
    }
}

function Assert-GuildbookResumeContext {
    param([Parameter(Mandatory=$true)]$Saved,[Parameter(Mandatory=$true)]$Current)
    foreach ($property in @(
        'machine','windows_sid','fixture_root','fixture_phase','fixture_digest',
        'installation_id','artifact_sha256','executable_sha256',
        'settings_sha256','guildbook_store_sha256','guildbook_file_count','guildbook_account_count'
    )) {
        if ($null -eq $Saved.PSObject.Properties[$property] -or
            $null -eq $Current.PSObject.Properties[$property] -or
            -not [string]::Equals([string]$Saved.$property,[string]$Current.$property,[StringComparison]::OrdinalIgnoreCase)) {
            throw 'Checkpoint context invalidated; cannot reuse previous PASS'
        }
    }
    return $true
}

function Test-SyntheticAccountStore {
    param(
        [Parameter(Mandatory=$true)][string]$GuildbookStore,
        [Parameter(Mandatory=$true)][string]$InstallationId,
        [Parameter(Mandatory=$true)][int]$ExpectedAccountCount
    )
    $store = Get-GuildbookStoreState -Root $GuildbookStore
    if (-not $store.Pass) { return $false }
    $bytes = [Text.Encoding]::UTF8.GetBytes($InstallationId)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $installationHash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()
    } finally {
        $sha.Dispose()
        [Array]::Clear($bytes,0,$bytes.Length)
    }
    $accountHashes = @{}
    foreach ($key in $store.Inventory.Keys) {
        if ($key -cmatch ('^([0-9a-f]{64})/' + $installationHash + '/snapshot\.dat
    param([Parameter(Mandatory=$true)]$State)
    if ($State.schema -cne 'foreverdb-guildbook-resume/v1' -or
        $State.stage -cnotin $script:ResumeStages -or
        $null -eq $State.context -or
        $null -eq $State.checks -or
        $null -eq $State.run_id -or
        [string]$State.run_id -notmatch '^[0-9a-f]{32}$') {
        throw 'Checkpoint schema invalid'
    }
    foreach ($check in @($State.checks)) {
        if ([string]$check.id -notmatch '^[a-z0-9_]{2,64}$' -or
            [string]$check.status -cnotin @('PASS','FAIL') -or
            [string]$check.evidence -cnotin @('AUTO','MANUAL') -or
            [string]$check.code -notmatch '^[A-Z0-9_]{2,64}$') {
            throw 'Checkpoint evidence invalid'
        }
    }
}

function Read-GuildbookResumeState {
    param([Parameter(Mandatory=$true)][string]$Path)
    $encrypted = $null
    $decoded = $null
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -gt 1048576 -or $item.Length -lt 20) {
            throw 'Invalid checkpoint file'
        }
        $encrypted = [Convert]::FromBase64String([IO.File]::ReadAllText($Path,[Text.Encoding]::ASCII).Trim())
        $decoded = [Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted,$script:ResumeEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $state = [Text.Encoding]::UTF8.GetString($decoded) | ConvertFrom-Json -ErrorAction Stop
        Test-ResumeStateShape -State $state
        return $state
    } catch {
        throw 'DPAPI checkpoint missing, unreadable or invalid (no evidence imported)'
    } finally {
        if ($null -ne $encrypted) { [Array]::Clear($encrypted,0,$encrypted.Length) }
        if ($null -ne $decoded) { [Array]::Clear($decoded,0,$decoded.Length) }
    }
}

function Write-GuildbookResumeState {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)]$State,
        [switch]$CreateOnly
    )
    Test-ResumeStateShape -State $State
    if ($CreateOnly -and [IO.File]::Exists($Path)) { throw 'Checkpoint already exists; use -Resume' }
    $temp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $backup = $Path + '.bak'
    $plain = $null
    $encrypted = $null
    try {
        foreach ($candidate in @($Path,$backup)) {
            if ([IO.File]::Exists($candidate)) {
                $existing = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
                if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'Unsafe checkpoint reparse point'
                }
            }
        }
        $plain = [Text.Encoding]::UTF8.GetBytes(($State | ConvertTo-Json -Depth 12 -Compress))
        $encrypted = [Security.Cryptography.ProtectedData]::Protect(
            $plain,$script:ResumeEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllText($temp,[Convert]::ToBase64String($encrypted),[Text.Encoding]::ASCII)
        if ([IO.File]::Exists($Path)) {
            if ($CreateOnly) { throw 'Checkpoint already exists' }
            [IO.File]::Replace($temp,$Path,$backup)
        } else {
            [IO.File]::Move($temp,$Path)
        }
    } finally {
        if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
        if ($null -ne $encrypted) { [Array]::Clear($encrypted,0,$encrypted.Length) }
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
}

function New-GuildbookResumeState {
    param([Parameter(Mandatory=$true)]$Context)
    return [pscustomobject]@{
        schema = 'foreverdb-guildbook-resume/v1'
        run_id = [Guid]::NewGuid().ToString('N')
        stage = 'AwaitOfflineA'
        context = $Context
        checks = @()
    }
}

function Add-GuildbookResumeCheck {
    param([Parameter(Mandatory=$true)]$State,[Parameter(Mandatory=$true)]$Check)
    if ($Check.status -cnotin @('PASS','FAIL')) { throw 'Cannot checkpoint unverified evidence' }
    if (@($State.checks | Where-Object { $_.id -ceq $Check.id }).Count -gt 0) {
        throw 'Evidence already checkpointed'
    }
    $State.checks = @($State.checks) + @($Check)
}

Export-ModuleMember -Function Get-GuildbookResumePath, Get-GuildbookResumeContext, Assert-GuildbookResumeContext, Read-GuildbookResumeState, Write-GuildbookResumeState, New-GuildbookResumeState, Add-GuildbookResumeCheck, Test-SyntheticAccountStore, Test-OfflineRouteSafety
)) {
            $accountHashes[$Matches[1]] = $true
        }
    }
    return $accountHashes.Count -eq $ExpectedAccountCount
}

function Test-OfflineRouteSafety {
    param([object[]]$Interfaces,[object[]]$Routes)
    if ($null -eq $Interfaces -or $null -eq $Routes) { return $false }
    foreach ($route in $Routes) {
        if ($route.DestinationPrefix -notin @('0.0.0.0/0','::/0')) { continue }
        if (@($Interfaces | Where-Object {
            $_.ConnectionState -eq 'Connected' -and
            $_.InterfaceIndex -eq $route.InterfaceIndex
        }).Count -gt 0) { return $false }
    }
    return $true
}

function Test-ResumeStateShape {
    param([Parameter(Mandatory=$true)]$State)
    if ($State.schema -cne 'foreverdb-guildbook-resume/v1' -or
        $State.stage -cnotin $script:ResumeStages -or
        $null -eq $State.context -or
        $null -eq $State.checks -or
        $null -eq $State.run_id -or
        [string]$State.run_id -notmatch '^[0-9a-f]{32}$') {
        throw 'Checkpoint schema invalid'
    }
    foreach ($check in @($State.checks)) {
        if ([string]$check.id -notmatch '^[a-z0-9_]{2,64}$' -or
            [string]$check.status -cnotin @('PASS','FAIL') -or
            [string]$check.evidence -cnotin @('AUTO','MANUAL') -or
            [string]$check.code -notmatch '^[A-Z0-9_]{2,64}$') {
            throw 'Checkpoint evidence invalid'
        }
    }
}

function Read-GuildbookResumeState {
    param([Parameter(Mandatory=$true)][string]$Path)
    $encrypted = $null
    $decoded = $null
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $item.Length -gt 1048576 -or $item.Length -lt 20) {
            throw 'Invalid checkpoint file'
        }
        $encrypted = [Convert]::FromBase64String([IO.File]::ReadAllText($Path,[Text.Encoding]::ASCII).Trim())
        $decoded = [Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted,$script:ResumeEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        $state = [Text.Encoding]::UTF8.GetString($decoded) | ConvertFrom-Json -ErrorAction Stop
        Test-ResumeStateShape -State $state
        return $state
    } catch {
        throw 'DPAPI checkpoint missing, unreadable or invalid (no evidence imported)'
    } finally {
        if ($null -ne $encrypted) { [Array]::Clear($encrypted,0,$encrypted.Length) }
        if ($null -ne $decoded) { [Array]::Clear($decoded,0,$decoded.Length) }
    }
}

function Write-GuildbookResumeState {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)]$State,
        [switch]$CreateOnly
    )
    Test-ResumeStateShape -State $State
    if ($CreateOnly -and [IO.File]::Exists($Path)) { throw 'Checkpoint already exists; use -Resume' }
    $temp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $backup = $Path + '.bak'
    $plain = $null
    $encrypted = $null
    try {
        foreach ($candidate in @($Path,$backup)) {
            if ([IO.File]::Exists($candidate)) {
                $existing = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
                if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'Unsafe checkpoint reparse point'
                }
            }
        }
        $plain = [Text.Encoding]::UTF8.GetBytes(($State | ConvertTo-Json -Depth 12 -Compress))
        $encrypted = [Security.Cryptography.ProtectedData]::Protect(
            $plain,$script:ResumeEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllText($temp,[Convert]::ToBase64String($encrypted),[Text.Encoding]::ASCII)
        if ([IO.File]::Exists($Path)) {
            if ($CreateOnly) { throw 'Checkpoint already exists' }
            [IO.File]::Replace($temp,$Path,$backup)
        } else {
            [IO.File]::Move($temp,$Path)
        }
    } finally {
        if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) }
        if ($null -ne $encrypted) { [Array]::Clear($encrypted,0,$encrypted.Length) }
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
}

function New-GuildbookResumeState {
    param([Parameter(Mandatory=$true)]$Context)
    return [pscustomobject]@{
        schema = 'foreverdb-guildbook-resume/v1'
        run_id = [Guid]::NewGuid().ToString('N')
        stage = 'AwaitOfflineA'
        context = $Context
        checks = @()
    }
}

function Add-GuildbookResumeCheck {
    param([Parameter(Mandatory=$true)]$State,[Parameter(Mandatory=$true)]$Check)
    if ($Check.status -cnotin @('PASS','FAIL')) { throw 'Cannot checkpoint unverified evidence' }
    if (@($State.checks | Where-Object { $_.id -ceq $Check.id }).Count -gt 0) {
        throw 'Evidence already checkpointed'
    }
    $State.checks = @($State.checks) + @($Check)
}

Export-ModuleMember -Function Get-GuildbookResumePath, Get-GuildbookResumeContext, Assert-GuildbookResumeContext, Read-GuildbookResumeState, Write-GuildbookResumeState, New-GuildbookResumeState, Add-GuildbookResumeCheck
