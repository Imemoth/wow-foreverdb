param(
    [string]$Ref = 'release',
    [string]$AddOnsPath,
    [string]$RepositoryPath
)

$ErrorActionPreference = 'Stop'
$repo = if ($RepositoryPath) { $RepositoryPath } else { Split-Path -Parent $PSScriptRoot }
$repo = [IO.Path]::GetFullPath($repo)
$stage = $null
$archive = $null
$backup = $null
$destination = $null
$installed = $false

function Invoke-Git([string[]]$Arguments) {
    $output = & git -C $repo @Arguments
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments[0]) failed: $($output -join ' ')" }
    return ($output -join "`n").Trim()
}

function Get-Version([string]$Toc) {
    $match = [regex]::Match((Get-Content -LiteralPath $Toc -Raw), '(?m)^## Version:\s*(\S+)\s*$')
    if (-not $match.Success) { throw "Missing addon version in $Toc" }
    return $match.Groups[1].Value
}

function Get-ForeverAddOns {
    $roots = @($env:USERPROFILE, $env:ProgramFiles, ${env:ProgramFiles(x86)}) |
        Where-Object { $_ } |
        ForEach-Object { Join-Path $_ 'World of Warcraft' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Container } |
        Select-Object -Unique
    $paths = foreach ($root in $roots) {
        foreach ($client in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            if ($client.Name -like '*forever*') {
                $candidate = Join-Path $client.FullName 'Interface/AddOns'
                if (Test-Path -LiteralPath $candidate -PathType Container) {
                    [IO.Path]::GetFullPath($candidate)
                }
            }
        }
    }
    return @($paths | Sort-Object -Unique)
}

try {
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw "Not a Git clone: $repo" }
    if ($Ref -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $Ref.Contains('..')) {
        throw "Invalid ref: $Ref"
    }
    # Fetch the requested remote ref even if this checkout has unrelated local changes.
    # FETCH_HEAD is valid only after this invocation succeeds.
    Invoke-Git @('fetch', '--no-tags', 'origin', $Ref) | Out-Null
    $sha = Invoke-Git @('rev-parse', '--verify', 'FETCH_HEAD^{commit}')
    if ($sha -notmatch '^[a-f0-9]{40}$') { throw "Invalid fetched commit: $sha" }

    if (-not $AddOnsPath) {
        $found = @(Get-ForeverAddOns)
        if ($found.Count -eq 0) { throw 'No *forever* client AddOns folder found. Supply -AddOnsPath.' }
        if ($found.Count -gt 1) { throw "Multiple Forever installations found; choose -AddOnsPath explicitly: $($found -join '; ')" }
        $AddOnsPath = $found[0]
    }
    $AddOnsPath = [IO.Path]::GetFullPath($AddOnsPath.Trim('"'))
    if (-not (Test-Path -LiteralPath $AddOnsPath -PathType Container)) { throw "AddOns folder does not exist: $AddOnsPath" }
    if ((Split-Path $AddOnsPath -Leaf) -ine 'AddOns' -or (Split-Path (Split-Path $AddOnsPath -Parent) -Leaf) -ine 'Interface') {
        throw "Destination must end in Interface/AddOns: $AddOnsPath"
    }
    if ($AddOnsPath -match '(?i)(^|[\\/])_classic_beta_([\\/]|$)') { throw "Refusing beta client destination: $AddOnsPath" }

    $token = [guid]::NewGuid().ToString('N')
    $archive = Join-Path ([IO.Path]::GetTempPath()) "foreverdb-$token.zip"
    $extract = Join-Path ([IO.Path]::GetTempPath()) "foreverdb-$token"
    $stage = Join-Path $AddOnsPath ".ForeverDB-stage-$token"
    $backup = Join-Path $AddOnsPath ".ForeverDB-backup-$token"
    $destination = Join-Path $AddOnsPath 'ForeverDB'

    Invoke-Git @('archive', '--format=zip', "--output=$archive", $sha, 'addon/ForeverDB') | Out-Null
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'Git archive is missing' }
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    $source = Join-Path $extract 'addon/ForeverDB'
    $sourceToc = Join-Path $source 'ForeverDB.toc'
    $sourceCore = Join-Path $source 'Core.lua'
    if (-not (Test-Path -LiteralPath $sourceToc -PathType Leaf) -or -not (Test-Path -LiteralPath $sourceCore -PathType Leaf)) {
        throw 'Selected commit has no complete ForeverDB addon source'
    }
    $version = Get-Version $sourceToc
    $coreMatch = [regex]::Match((Get-Content -LiteralPath $sourceCore -Raw), 'FDB\.VERSION\s*=\s*"([^"]+)"')
    if (-not $coreMatch.Success -or $coreMatch.Groups[1].Value -ne $version) { throw 'Source Core.lua and TOC versions disagree' }
    Copy-Item -LiteralPath $source -Destination $stage -Recurse
    if ((Get-Version (Join-Path $stage 'ForeverDB.toc')) -ne $version) { throw 'Staged TOC version mismatch' }

    Write-Host "Source ref: $Ref"
    Write-Host "Commit: $sha"
    Write-Host "Addon version: $version"
    Write-Host "Destination: $destination"
    if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination $backup }
    try {
        Move-Item -LiteralPath $stage -Destination $destination
        if ((Get-Version (Join-Path $destination 'ForeverDB.toc')) -ne $version) { throw 'Installed TOC version mismatch' }
        $installed = $true
    } catch {
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $destination }
        throw
    }
    Write-Host "ForeverDB $version installed. Use /reload, then /fdb quest status."
} catch {
    Write-Error "Addon update failed: $_"
    exit 1
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
    if ($archive -and (Test-Path -LiteralPath $archive)) { Remove-Item -LiteralPath $archive -Force }
    if ($extract -and (Test-Path -LiteralPath $extract)) { Remove-Item -LiteralPath $extract -Recurse -Force }
    if ($installed -and $backup -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Recurse -Force }
}
