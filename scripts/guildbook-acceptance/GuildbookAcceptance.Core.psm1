Set-StrictMode -Version Latest

# Read-only helpers. No Guildbook contents, account identifiers, tokens, or filenames
# are returned in public evidence. In-memory hashes are used only for comparisons.

function Test-AcceptanceEnvironment {
    $windows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    $local = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $ok = $windows -and [Environment]::Is64BitOperatingSystem -and
        ($PSVersionTable.PSVersion.Major -ge 5) -and
        -not [string]::IsNullOrWhiteSpace($local)
    if (-not $ok) { return [pscustomobject]@{ Pass = $false; Code = 'WINDOWS_X64_REQUIRED' } }
    try {
        Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
        $plain = [Text.Encoding]::UTF8.GetBytes('synthetic-dpapi-probe')
        $encrypted = [Security.Cryptography.ProtectedData]::Protect(
            $plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $unsealed = [Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $pass = [Convert]::ToBase64String($plain) -ceq [Convert]::ToBase64String($unsealed)
        [Array]::Clear($plain, 0, $plain.Length)
        [Array]::Clear($encrypted, 0, $encrypted.Length)
        [Array]::Clear($unsealed, 0, $unsealed.Length)
        if (-not $pass) { throw 'DPAPI probe mismatch' }
    } catch {
        return [pscustomobject]@{ Pass = $false; Code = 'DPAPI_UNAVAILABLE' }
    }
    return [pscustomobject]@{ Pass = $true; Code = 'OK' }
}

function Test-CompanionArtifact {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$CompanionDirectory,
        [Parameter(Mandatory = $true)][string]$ExpectedArchiveSha,
        [string]$ExpectedVersion = '0.9.0',
        [switch]$SkipVersionCheckForSyntheticTest
    )
    $outcome = [ordered]@{ Pass = $false; Code = 'ARTIFACT_INVALID'; Files = 0; Version = $null }
    $zip = $null
    try {
        if (-not [IO.File]::Exists($ArchivePath) -or -not [IO.Directory]::Exists($CompanionDirectory)) {
            $outcome.Code = 'ARCHIVE_OR_EXTRACTION_MISSING'
            return [pscustomobject]$outcome
        }
        $digest = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256 -ErrorAction Stop).Hash
        if (-not $digest.Equals($ExpectedArchiveSha, [StringComparison]::OrdinalIgnoreCase)) {
            $outcome.Code = 'ARCHIVE_SHA256_MISMATCH'
            return [pscustomobject]$outcome
        }
        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
        $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
        $root = [IO.Path]::GetFullPath($CompanionDirectory).TrimEnd('\', '/') +
            [IO.Path]::DirectorySeparatorChar
        $foundExe = $false
        $sawFiles = @{}
        foreach ($entry in $zip.Entries) {
            if ([string]::IsNullOrEmpty($entry.Name)) { continue }
            $relative = $entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar)
            $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relative))
            if (-not $candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                $outcome.Code = 'UNSAFE_ARCHIVE_PATH'
                return [pscustomobject]$outcome
            }
            if ($sawFiles.ContainsKey($candidate)) {
                $outcome.Code = 'DUPLICATE_ARCHIVE_PATH'
                return [pscustomobject]$outcome
            }
            $sawFiles[$candidate] = $true
            if (-not [IO.File]::Exists($candidate)) {
                $outcome.Code = 'EXTRACTED_FILE_MISSING'
                return [pscustomobject]$outcome
            }
            $fileInfo = [IO.FileInfo]$candidate
            if (($fileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $outcome.Code = 'REPARSE_POINT_IN_PACKAGE'
                return [pscustomobject]$outcome
            }
            if ($fileInfo.Length -ne $entry.Length) {
                $outcome.Code = 'EXTRACTED_FILE_MISMATCH'
                return [pscustomobject]$outcome
            }
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $entryHash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
            } finally {
                $stream.Dispose()
                $sha.Dispose()
            }
            $fileHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256 -ErrorAction Stop).Hash
            if (-not $entryHash.Equals($fileHash, [StringComparison]::OrdinalIgnoreCase)) {
                $outcome.Code = 'EXTRACTED_FILE_MISMATCH'
                return [pscustomobject]$outcome
            }
            $outcome.Files++
            if ($entry.Name.Equals('ForeverDB.Companion.exe', [StringComparison]::OrdinalIgnoreCase)) {
                if ($relative -ne 'ForeverDB.Companion.exe') {
                    $outcome.Code = 'UNEXPECTED_EXE_LOCATION'
                    return [pscustomobject]$outcome
                }
                $foundExe = $true
                $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($candidate)
                $version = [string]$versionInfo.ProductVersion
                if ([string]::IsNullOrWhiteSpace($version)) { $version = [string]$versionInfo.FileVersion }
                if (-not $SkipVersionCheckForSyntheticTest) {
                    if ($version -notmatch ('(?<![0-9])' + [regex]::Escape($ExpectedVersion) + '(?![0-9])')) {
                        $outcome.Code = 'COMPANION_VERSION_MISMATCH'
                        return [pscustomobject]$outcome
                    }
                }
                $outcome.Version = if ($SkipVersionCheckForSyntheticTest) { 'SYNTHETIC' } else { $version }
            }
        }
        if (-not $foundExe -or $outcome.Files -lt 1) {
            $outcome.Code = 'COMPANION_EXE_MISSING'
            return [pscustomobject]$outcome
        }
        $outcome.Pass = $true
        $outcome.Code = 'OK'
        return [pscustomobject]$outcome
    } catch {
        $outcome.Code = 'ARTIFACT_READ_ERROR'
        return [pscustomobject]$outcome
    } finally {
        if ($null -ne $zip) { $zip.Dispose() }
    }
}

function Test-GuildbookDpapiFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $protected = $null
    $plain = $null
    try {
        $file = [IO.FileInfo]$Path
        if ($file.Length -lt 20 -or $file.Length -gt 33554432) { return $false }
        $encoded = [IO.File]::ReadAllText($Path, [Text.Encoding]::ASCII)
        $protected = [Convert]::FromBase64String($encoded.Trim())
        $plain = [Security.Cryptography.ProtectedData]::Unprotect(
            $protected, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        return $plain.Length -gt 1
    } catch {
        return $false
    } finally {
        if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
        if ($null -ne $protected) { [Array]::Clear($protected, 0, $protected.Length) }
    }
}

function Get-GuildbookStoreState {
    param([Parameter(Mandatory = $true)][string]$Root)
    $state = [ordered]@{
        Pass = $true; Code = 'OK'; Exists = $false;
        AccountCount = 0; InstallationCount = 0; FileCount = 0;
        AccountSet = @{}; Inventory = @{}
    }
    try {
        if (-not [IO.Directory]::Exists($Root)) {
            if ([IO.File]::Exists($Root)) { throw 'Unexpected file at storage root' }
            return [pscustomobject]$state
        }
        $state.Exists = $true
        $rootInfo = [IO.DirectoryInfo]$Root
        if (($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $state.Code = 'UNSAFE_REPARSE_POINT'
            $state.Pass = $false
            return [pscustomobject]$state
        }
        $accounts = @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction Stop)
        foreach ($account in $accounts) {
            if (-not $account.PSIsContainer -or $account.Name -cnotmatch '^[0-9a-f]{64}$' -or
                (($account.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                throw 'Invalid account namespace'
            }
            $state.AccountSet[$account.Name] = $true
            $state.AccountCount++
            $installations = @(Get-ChildItem -LiteralPath $account.FullName -Force -ErrorAction Stop)
            foreach ($installation in $installations) {
                if (-not $installation.PSIsContainer -or $installation.Name -cnotmatch '^[0-9a-f]{64}$' -or
                    (($installation.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                    throw 'Invalid installation namespace'
                }
                $state.InstallationCount++
                $files = @(Get-ChildItem -LiteralPath $installation.FullName -Force -ErrorAction Stop)
                if ($files.Count -eq 0) { throw 'Empty installation namespace' }
                $hasMain = $false
                foreach ($file in $files) {
                    if ($file.PSIsContainer -or ($file.Name -cne 'snapshot.dat' -and $file.Name -cne 'snapshot.dat.bak') -or
                        (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                        throw 'Unknown file or reparse point'
                    }
                    if ($file.Name -ceq 'snapshot.dat') { $hasMain = $true }
                    if (-not (Test-GuildbookDpapiFile -Path $file.FullName)) {
                        $state.Code = 'DPAPI_UNREADABLE'
                        $state.Pass = $false
                        return [pscustomobject]$state
                    }
                    $relative = $account.Name + '/' + $installation.Name + '/' + $file.Name
                    $state.Inventory[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
                    $state.FileCount++
                }
                if (-not $hasMain) { throw 'Missing primary snapshot file' }
            }
        }
        return [pscustomobject]$state
    } catch {
        $state.Pass = $false
        $state.Code = 'INVALID_LAYOUT_OR_ACCESS'
        return [pscustomobject]$state
    }
}

function Test-StorePreserved {
    param(
        [Parameter(Mandatory = $true)]$Before,
        [Parameter(Mandatory = $true)]$After,
        [switch]$AllowAdditionalFiles
    )
    if (-not $Before.Pass -or -not $After.Pass) { return $false }
    if (-not $AllowAdditionalFiles -and $Before.Inventory.Count -ne $After.Inventory.Count) { return $false }
    foreach ($key in $Before.Inventory.Keys) {
        if (-not $After.Inventory.ContainsKey($key) -or $Before.Inventory[$key] -cne $After.Inventory[$key]) {
            return $false
        }
    }
    return $true
}

function Test-SeparateAccountCreated {
    param([Parameter(Mandatory = $true)]$Before, [Parameter(Mandatory = $true)]$After)
    if (-not $Before.Pass -or -not $After.Pass -or
        $After.AccountCount -ne ($Before.AccountCount + 1) -or
        $After.FileCount -le $Before.FileCount) { return $false }
    return (Test-StorePreserved -Before $Before -After $After -AllowAdditionalFiles)
}

function New-AcceptanceCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [ValidateSet('AUTO', 'MANUAL', 'NOT_VERIFIED')][string]$Evidence,
        [ValidateSet('PASS', 'FAIL', 'BLOCKED')][string]$Status,
        [Parameter(Mandatory = $true)][string]$Code,
        [bool]$Required = $true
    )
    return [pscustomobject]@{
        id = $Id; evidence = $Evidence; status = $Status; code = $Code; required = $Required
    }
}

function Get-AcceptanceOutcome {
    param([Parameter(Mandatory = $true)][object[]]$Checks)
    $required = @($Checks | Where-Object { $_.required })
    if (@($required | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) { return 'FAIL' }
    if ($required.Count -eq 0 -or @($required | Where-Object { $_.status -ne 'PASS' }).Count -gt 0) {
        return 'BLOCKED'
    }
    return 'PASS'
}

function Write-AcceptanceReport {
    param(
        [Parameter(Mandatory = $true)][object[]]$Checks,
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$TestMode,
        [Parameter(Mandatory = $true)][string]$BuildSha,
        [Parameter(Mandatory = $true)][string]$ArtifactDigest
    )
    if (-not [IO.Directory]::Exists($Directory)) {
        [IO.Directory]::CreateDirectory($Directory) | Out-Null
    }
    $outcome = Get-AcceptanceOutcome -Checks $Checks
    $when = [DateTimeOffset]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
    $report = [ordered]@{
        schema = 'guildbook-local-only-acceptance/v1'
        mode = $TestMode
        timestamp_utc = $when
        result = $outcome
        source_head = $BuildSha
        workflow_run = 40074802791
        artifact_id = 12551933942
        artifact_sha256 = $ArtifactDigest
        checks = @($Checks | ForEach-Object {
            [ordered]@{
                id = [string]$_.id; evidence = [string]$_.evidence;
                status = [string]$_.status; code = [string]$_.code;
                required = [bool]$_.required
            }
        })
        limits = @(
            'No tokens, account IDs, paths, encrypted hashes or Guildbook content recorded.',
            'Only the pinned ZIP and local read-only checks are automated; UI attestations are manual.',
            'No runtime HTTP packet inspection; no-Guildbook-RPC is supported by pinned CI regressions.',
            'Verified offline identity may lag later server-side revocation until next online check.',
            'WoW SavedVariables source remains separate and is not DPAPI-protected.'
        )
    }
    $fileName = 'guildbook-acceptance-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') +
        '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.json'
    $path = [IO.Path]::Combine($Directory, $fileName)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 8))
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    } finally {
        $stream.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
    return [pscustomobject]@{ Result = $outcome; Path = $path }
}

Export-ModuleMember -Function Test-AcceptanceEnvironment, Test-CompanionArtifact, Test-GuildbookDpapiFile, Get-GuildbookStoreState, Test-StorePreserved, Test-SeparateAccountCreated, New-AcceptanceCheck, Get-AcceptanceOutcome, Write-AcceptanceReport
