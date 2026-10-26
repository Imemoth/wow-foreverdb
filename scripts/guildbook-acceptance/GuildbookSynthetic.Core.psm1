Set-StrictMode -Version Latest

# Synthetic fixture data are fictional. No actual World of Warcraft, ForeverDB,
# identity credential or Supabase resource is read or modified.

function Assert-SyntheticPath {
    param([Parameter(Mandatory=$true)][string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    if (-not [IO.Directory]::Exists($full)) { throw 'Synthetic path missing' }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Synthetic path is a reparse point' }
    return $full
}

function Get-SyntheticActivePath {
    param([Parameter(Mandatory=$true)][string]$Root)
    Join-Path $Root 'wow\WTF\Account\SYNTHETIC_ACCEPTANCE\SavedVariables\ForeverDB.lua'
}

function Get-SyntheticManifest {
    param([Parameter(Mandatory=$true)][string]$FixtureRoot)
    $root = Assert-SyntheticPath -Path $FixtureRoot
    $name = [IO.Path]::GetFileName($root.TrimEnd('\','/'))
    if ($name -cnotmatch '^synthetic-[0-9a-f]{32}$') { throw 'Not a synthetic fixture' }
    $parent = Assert-SyntheticPath -Path ([IO.Path]::GetDirectoryName($root))
    if ([IO.Path]::GetFileName($parent.TrimEnd('\','/')) -cne 'synthetic-fixtures') { throw 'Unexpected fixture parent' }
    $manifestPath = Join-Path $root '.synthetic-fixture.json'
    $activePath = Get-SyntheticActivePath -Root $root
    if (-not [IO.File]::Exists($manifestPath) -or -not [IO.File]::Exists($activePath)) {
        throw 'Synthetic fixture incomplete'
    }
    foreach ($file in @($manifestPath,$activePath)) {
        if (([IO.FileInfo]$file).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Refusing fixture reparse point'
        }
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ($manifest.schema -cne 'foreverdb-guildbook-synthetic/v1' -or
        $manifest.phase -cnotin @('Setup','A','B') -or
        [string]$manifest.installation_id -cnotmatch '^[0-9a-f]{32}$' -or
        [string]$manifest.digest -cnotmatch '^[0-9A-Fa-f]{64}$' -or
        [long]$manifest.last_capture_at -lt 0) { throw 'Synthetic manifest invalid' }
    $actual = (Get-FileHash -LiteralPath $activePath -Algorithm SHA256 -ErrorAction Stop).Hash
    if ($actual -cne ([string]$manifest.digest).ToUpperInvariant()) { throw 'Refusing to replace a modified fixture' }
    return [pscustomobject]@{ Root=$root; WowRoot=(Join-Path $root 'wow'); ActivePath=$activePath; ManifestPath=$manifestPath; Manifest=$manifest }
}

function New-GuildbookSyntheticFixture {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$OutputParent)

    $parent = [IO.Path]::GetFullPath($OutputParent)
    if ([IO.Path]::GetFileName($parent.TrimEnd('\','/')) -cne 'synthetic-fixtures') {
        throw 'Use a dedicated synthetic-fixtures parent directory'
    }
    $appdata = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if ($parent.StartsWith($appdata,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing a fixture inside existing application data'
    }
    # Directory.CreateDirectory below only creates the dedicated fixture parent;
    # it never replaces files or directories.
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $parent = Assert-SyntheticPath -Path $parent
    $root = Join-Path $parent ('synthetic-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $activePath = Get-SyntheticActivePath -Root $root
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($activePath)) | Out-Null
    $install = [Guid]::NewGuid().ToString('N')
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $lua = 'ForeverDB_Export = "H|9|0.9.0-alpha|{0}|{1}"' -f $install, $now
    [IO.File]::WriteAllText($activePath, $lua, [Text.Encoding]::ASCII)
    $digest = (Get-FileHash -LiteralPath $activePath -Algorithm SHA256).Hash
    $manifest = [ordered]@{
        schema = 'foreverdb-guildbook-synthetic/v1'
        phase = 'Setup'
        installation_id = $install
        last_capture_at = 0
        digest = $digest
    }
    $manifestPath = Join-Path $root '.synthetic-fixture.json'
    [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 3), [Text.Encoding]::UTF8)
    return (Get-SyntheticManifest -FixtureRoot $root)
}

function Set-GuildbookSyntheticFixturePhase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$FixtureRoot,
        [ValidateSet('A','B')][Parameter(Mandatory=$true)][string]$Phase
    )
    $fixture = Get-SyntheticManifest -FixtureRoot $FixtureRoot
    $previous = [string]$fixture.Manifest.phase
    if ($previous -eq $Phase) { return $fixture } # idempotent: never replace a valid stage
    if (($previous -eq 'Setup' -and $Phase -ne 'A') -or
        ($previous -eq 'A' -and $Phase -ne 'B') -or
        $previous -eq 'B') { throw 'Synthetic phases must proceed Setup -> A -> B' }

    $captureAt = [Math]::Max(
        [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 180,
        ([long]$fixture.Manifest.last_capture_at) + 1)
    $capId = [Guid]::NewGuid().ToString('N')
    $guildKey = 'guild-' + $Phase.ToLowerInvariant()
    $member = 'Member' + $Phase
    $lines = @(
        ('H|9|0.9.0-alpha|{0}|{1}|{2}|{3}|SyntheticCharacter{4}' -f $fixture.Manifest.installation_id,$captureAt,$capId,$captureAt,$Phase),
        ('G|{0}|Synthetic Guild {1}|SyntheticRealm|{2}' -f $guildKey,$Phase,$captureAt),
        ('C|{0}|synthetic-member-{1}|{2}|Mage|MAGE|60|Member|0|1|SyntheticZone|0' -f $guildKey,$Phase.ToLowerInvariant(),$member),
        ('P|{0}|synthetic-member-{1}|171|Alchemy|300|300|guild|0' -f $guildKey,$Phase.ToLowerInvariant())
    )
    # Real WoW writes an escaped Lua string. ParseSavedVariables expands \n
    # while the source file itself remains ASCII, one physical line.
    $lua = 'ForeverDB_Export = "' + ($lines -join '\n') + '"'
    $bytes = [Text.Encoding]::ASCII.GetBytes($lua)
    $temp = $fixture.ActivePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $backup = $fixture.ActivePath + '.synthetic-previous'
    try {
        # Only touch files owned by this UUID fixture. Recheck before replacing.
        $unchanged = (Get-FileHash -LiteralPath $fixture.ActivePath -Algorithm SHA256).Hash
        if ($unchanged -cne ([string]$fixture.Manifest.digest).ToUpperInvariant()) {
            throw 'Synthetic fixture changed since check'
        }
        [IO.File]::WriteAllBytes($temp, $bytes)
        [IO.File]::Replace($temp, $fixture.ActivePath, $backup)
        $fixture.Manifest.phase = $Phase
        $fixture.Manifest.digest = (Get-FileHash -LiteralPath $fixture.ActivePath -Algorithm SHA256).Hash
        $fixture.Manifest.last_capture_at = $captureAt
        $manifestTemp = $fixture.ManifestPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        try {
            [IO.File]::WriteAllText($manifestTemp, ($fixture.Manifest | ConvertTo-Json -Depth 3),[Text.Encoding]::UTF8)
            [IO.File]::Replace($manifestTemp, $fixture.ManifestPath, ($fixture.ManifestPath + '.synthetic-previous'))
        } finally {
            if ([IO.File]::Exists($manifestTemp)) { [IO.File]::Delete($manifestTemp) }
        }
    } finally {
        [Array]::Clear($bytes,0,$bytes.Length)
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
    return (Get-SyntheticManifest -FixtureRoot $fixture.Root)
}

Export-ModuleMember -Function New-GuildbookSyntheticFixture, Set-GuildbookSyntheticFixturePhase, Get-SyntheticManifest
