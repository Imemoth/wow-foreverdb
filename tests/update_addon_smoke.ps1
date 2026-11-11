$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("fdb-updater-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $remote = Join-Path $root 'remote.git'; $repo = Join-Path $root 'repo'; $wow = Join-Path $root 'World of Warcraft'
    git init --bare $remote | Out-Null
    git clone $remote $repo 2>$null | Out-Null
    git -C $repo config user.name 'Smoke Test'; git -C $repo config user.email 'smoke@example.invalid'
    New-Item -ItemType Directory -Path (Join-Path $repo 'addon/ForeverDB') | Out-Null
    function Write-Version($version) {
        Set-Content (Join-Path $repo 'addon/ForeverDB/ForeverDB.toc') "## Version: $version`n## SavedVariables: ForeverDB_Saved" -NoNewline
        Set-Content (Join-Path $repo 'addon/ForeverDB/Core.lua') "FDB.VERSION = `"$version`"" -NoNewline
        git -C $repo add .; git -C $repo commit -m "addon $version" | Out-Null
    }
    git -C $repo switch -c release | Out-Null
    Write-Version '0.5.0-alpha'; git -C $repo push origin release | Out-Null
    git -C $repo switch -c feat/quest-tracker-v1-local-capture | Out-Null
    Write-Version '0.6.0-alpha'; git -C $repo push origin feat/quest-tracker-v1-local-capture | Out-Null
    $featureSha = (git -C $repo rev-parse HEAD).Trim()
    $forever = Join-Path $wow '_classic_forever_/Interface/AddOns'
    $beta = Join-Path $wow '_classic_beta_/Interface/AddOns'
    New-Item -ItemType Directory -Path $forever,$beta,(Join-Path $wow '_classic_forever_/WTF/Account') | Out-Null
    Set-Content (Join-Path $beta 'sentinel.txt') 'keep beta'
    Set-Content (Join-Path $wow '_classic_forever_/WTF/Account/SavedVariables.txt') 'keep saved variables'
    $updater = Join-Path (Split-Path $PSScriptRoot) 'scripts/update-addon.ps1'
    $shell = (Get-Process -Id $PID).Path
    $priorProfile=$env:USERPROFILE; $env:USERPROFILE=$root
    try {
        $output = & $shell -NoProfile -File $updater -RepositoryPath $repo -AddOnsPath $forever 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Default install failed: $output" }
        if ((Get-Content (Join-Path $forever 'ForeverDB/ForeverDB.toc') -Raw) -notmatch '0.5.0-alpha') { throw 'Default must use release' }
        $output = & $shell -NoProfile -File $updater -RepositoryPath $repo -Ref feat/quest-tracker-v1-local-capture -AddOnsPath $forever 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Feature install failed: $output" }
        if ($output -notmatch [regex]::Escape($featureSha) -or $output -notmatch '0.6.0-alpha') { throw 'Missing version/commit diagnostics' }
        if ((Get-Content (Join-Path $forever 'ForeverDB/ForeverDB.toc') -Raw) -notmatch '0.6.0-alpha') { throw 'Feature version not installed' }
        $output = & $shell -NoProfile -File $updater -RepositoryPath $repo -Ref $featureSha -AddOnsPath $forever 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Pinned commit install failed: $output" }
        $output = & $shell -NoProfile -File $updater -RepositoryPath $repo -Ref nonexistent-branch -AddOnsPath $forever 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { throw 'Missing remote branch should fail' }
        if ((Get-Content (Join-Path $forever 'ForeverDB/ForeverDB.toc') -Raw) -notmatch '0.6.0-alpha') { throw 'Failed fetch modified addon' }
        if (-not (Test-Path (Join-Path $beta 'sentinel.txt'))) { throw 'Beta changed' }
        if (-not (Test-Path (Join-Path $wow '_classic_forever_/WTF/Account/SavedVariables.txt'))) { throw 'SavedVariables changed' }
        $output = & $shell -NoProfile -File $updater -RepositoryPath $repo -AddOnsPath $beta 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { throw 'Beta destination should be rejected' }
        if ($env:OS -eq 'Windows_NT') {
            $wrapper = Join-Path (Split-Path $PSScriptRoot) 'update-addon.cmd'
            $cmd = '"{0}" -Ref "{1}" -AddOnsPath "{2}" -RepositoryPath "{3}"' -f $wrapper,$featureSha,$forever,$repo
            $output = & cmd.exe /d /c $cmd 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0 -or $output -notmatch [regex]::Escape($featureSha)) { throw "CMD wrapper did not forward args: $output" }
        }
        git -C $repo switch -c bad-version | Out-Null
        Set-Content (Join-Path $repo 'addon/ForeverDB/Core.lua') 'FDB.VERSION = "9.9.9-alpha"' -NoNewline
        git -C $repo add .; git -C $repo commit -m 'mismatched core version' | Out-Null
        git -C $repo push origin bad-version | Out-Null
        $output = & $shell -NoProfile -File $updater -Ref bad-version -AddOnsPath $forever -RepositoryPath $repo 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) { throw 'Mismatched source versions should fail' }
        if ((Get-Content (Join-Path $forever 'ForeverDB/ForeverDB.toc') -Raw) -notmatch '0.6.0-alpha') { throw 'Invalid source modified addon' }
        $second = Join-Path $root 'World of Warcraft/_forever_alt_/Interface/AddOns'
        New-Item -ItemType Directory -Path $second | Out-Null
        $env:USERPROFILE=$root
        $output = & $shell -NoProfile -File $updater -RepositoryPath $repo -Ref feat/quest-tracker-v1-local-capture 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -or $output -notmatch 'multiple') { throw "Multiple Forever installs need explicit selection: $output" }
        Write-Host 'PASS: release default, feature/pinned refs, failed fetch preservation, beta isolation, SavedVariables, multiple-install selection'
    } finally { $env:USERPROFILE=$priorProfile }
} finally { Remove-Item $root -Recurse -Force }
exit 0
