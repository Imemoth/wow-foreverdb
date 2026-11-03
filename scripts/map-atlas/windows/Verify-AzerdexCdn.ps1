<#
.SYNOPSIS
  Read-only verification of the AzerDex asset CDN (Cloudflare Pages project "azerdex-assets") for Windows PowerShell 5.1 and PowerShell 7+.

.DESCRIPTION
  Never uploads, deletes or changes anything: it only issues HTTPS GET requests to the allow-listed asset host and hashes local files.
  TLS certificate validation is never disabled. The result is written as an evidence JSON file; the verdict is PASS only when every check
  succeeded with real responses (any unreachable host, wrong byte, wrong header or wrong status is FAIL; nothing is assumed).

  Modes
    Baseline  BEFORE the upload: the live CDN must still serve exactly the 172-file approved atlas distribution (171 served files; `_headers`
              is a Pages config file and is never served). Table: scripts\map-atlas\baseline\atlas-dist-1.60.1.70450.json.
              The zone-heroes/ probes are expected to be 404 (nothing published there yet); a 200 is reported as a WARNING.
    Post      AFTER the upload: the live CDN must serve all 179 served files of the unified snapshot (atlas baseline + 8 heroes) with the
              expected headers (hero files: Content-Type image/webp, nosniff, Timing-Allow-Origin, immutable cache). Table:
              scripts\map-atlas\baseline\unified-dist-1.60.1.70450-8da4f1345f65.release.json.
    Local     Offline: a local folder or the unified .zip against the same table (pre-upload sanity check of the exact bytes you will upload).

.EXAMPLE
  .\Verify-AzerdexCdn.ps1 -Mode Local    -LocalDist C:\azerdex\azerdex-cdn-dist-1.60.1.70450-8da4f1345f65.zip
  .\Verify-AzerdexCdn.ps1 -Mode Baseline
  .\Verify-AzerdexCdn.ps1 -Mode Post
#>
[CmdletBinding()]
param(
  [ValidateSet('Baseline', 'Post', 'Local')][string]$Mode = 'Baseline',
  [string]$BaseUrl = 'https://azerdex-assets.pages.dev',
  [string]$TablePath,
  [string]$LocalDist,
  [string]$EvidencePath,
  [int]$TimeoutSec = 60,
  [switch]$AllowTestBase   # tests only: accept a non-allow-listed (e.g. http://127.0.0.1:8080) base URL
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$ToolVersion = '1.0'
$AllowedHosts = @('azerdex-assets.pages.dev', 'assets.azerdex.com')
$RepoScripts = Split-Path -Parent $PSScriptRoot
$Immutable = 'public, max-age=31536000, immutable'
$ExpectedHeaders = [ordered]@{
  'forever/'     = @{ 'cache-control' = $Immutable; 'access-control-allow-origin' = '*'; 'x-content-type-options' = 'nosniff' }
  'atlas/'       = @{ 'cache-control' = 'public, max-age=300, must-revalidate'; 'access-control-allow-origin' = '*'; 'x-content-type-options' = 'nosniff' }
  'zone-heroes/' = @{ 'cache-control' = $Immutable; 'access-control-allow-origin' = '*'; 'x-content-type-options' = 'nosniff'; 'timing-allow-origin' = '*' }
}
$MissingProbes = @('forever/9999999/v1/manifest.json', 'zone-heroes/9999999/v1/desktop-1280.webp', 'zone-heroes/1424/v999/desktop-1280.webp', 'atlas/not-a-file.json')

if (-not $TablePath) {
  $TablePath = if ($Mode -eq 'Baseline') { Join-Path $RepoScripts 'baseline\atlas-dist-1.60.1.70450.json' } else { Join-Path $RepoScripts 'baseline\unified-dist-1.60.1.70450-8da4f1345f65.release.json' }
}
if (-not $EvidencePath) { $EvidencePath = Join-Path (Get-Location) ("azerdex-cdn-{0}-{1}.json" -f $Mode.ToLower(), (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')) }

function Read-Table([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Table file not found: $path" }
  $j = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
  $src = if ($j.PSObject.Properties['files']) { $j.files } else { $j }
  $t = [ordered]@{}
  foreach ($p in ($src.PSObject.Properties | Sort-Object Name)) { $t[$p.Name] = @{ sha = ([string]$p.Value.sha256).ToLower(); bytes = [int64]$p.Value.bytes } }
  if ($t.Count -lt 100) { throw "Table $path lists only $($t.Count) files; refusing." }
  return $t
}

function Test-SafePath([string]$p) { return ($p -match '^(_headers|atlas/[a-z]+\.json|forever/[1-9][0-9]{0,5}/v[1-9][0-9]{0,3}/[A-Za-z0-9][A-Za-z0-9._-]*|zone-heroes/[1-9][0-9]{0,5}/v[1-9][0-9]{0,3}/(desktop|mobile)-[1-9][0-9]{2,4}\.webp)$') }

function Get-Sha256([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() }

function Get-HeaderValue($headers, [string]$name) {
  if ($null -eq $headers) { return $null }
  foreach ($k in $headers.Keys) { if ($k -ieq $name) { $v = $headers[$k]; if ($v -is [string]) { return $v } else { return (@($v) -join ', ') } } }
  return $null
}

# Cache-Control is compared as a set of directives: HTTP clients (e.g. .NET in PowerShell 7) may re-order or re-space them; every other header is exact.
function Test-HeaderEqual([string]$name, $got, [string]$want) {
  if ($null -eq $got) { return $false }
  if ($name -eq 'cache-control') {
    $a = @(($got.ToLower() -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object)
    $b = @(($want.ToLower() -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Sort-Object)
    return (($a -join ',') -eq ($b -join ','))
  }
  return ($got -eq $want)
}

function Invoke-Get([string]$url, [string]$outFile) {
  try {
    $r = Invoke-WebRequest -Uri $url -OutFile $outFile -PassThru -UseBasicParsing -TimeoutSec $TimeoutSec -MaximumRedirection 0
    return @{ Status = [int]$r.StatusCode; Headers = $r.Headers; Error = $null }
  } catch {
    $resp = $null
    if ($_.Exception.PSObject.Properties['Response']) { $resp = $_.Exception.Response }
    if ($null -ne $resp -and $null -ne $resp.StatusCode) { return @{ Status = [int]$resp.StatusCode; Headers = $null; Error = $null } }
    return @{ Status = 0; Headers = $null; Error = $_.Exception.Message }
  }
}

$run = [ordered]@{
  tool = "Verify-AzerdexCdn.ps1 $ToolVersion"; mode = $Mode; baseUrl = $BaseUrl; table = $TablePath; powershell = $PSVersionTable.PSVersion.ToString()
  machine = $env:COMPUTERNAME; startedUtc = (Get-Date).ToUniversalTime().ToString('o'); finishedUtc = $null
  expectedFiles = 0; checked = 0; ok = 0; failures = @(); warnings = @(); probes = @(); rows = @(); verdict = 'FAIL'
}
function Add-Fail([string]$m) { $script:run.failures += $m; Write-Host "  FAIL  $m" -ForegroundColor Red }
function Add-Warn([string]$m) { $script:run.warnings += $m; Write-Host "  WARN  $m" -ForegroundColor Yellow }

$table = Read-Table $TablePath
foreach ($p in $table.Keys) { if (-not (Test-SafePath $p)) { throw "Table contains an unexpected path: $p" } }
$served = @($table.Keys | Where-Object { $_ -ne '_headers' })
if ($Mode -eq 'Baseline') { $served = @($served | Where-Object { $_ -notlike 'zone-heroes/*' }) }
$run.expectedFiles = $served.Count
Write-Host ("Mode {0}: {1} files expected from {2}" -f $Mode, $served.Count, (Split-Path -Leaf $TablePath))

if ($Mode -eq 'Local') {
  if (-not $LocalDist -or -not (Test-Path -LiteralPath $LocalDist)) { throw '-LocalDist <folder or .zip> is required in Local mode' }
  $root = $LocalDist
  if ((Get-Item -LiteralPath $LocalDist).PSIsContainer -eq $false) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('azerdex-dist-' + [Guid]::NewGuid().ToString('N'))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($LocalDist, $root)   # entries are validated below; names outside the table are failures
    $run['archiveSha256'] = Get-Sha256 $LocalDist
  }
  $root = (Resolve-Path -LiteralPath $root).Path
  $onDisk = @(Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object { $_.FullName.Substring($root.Length).TrimStart('\', '/').Replace('\', '/') })
  foreach ($x in ($onDisk | Where-Object { -not $table.Contains($_) })) { Add-Fail "unexpected file: $x" }
  foreach ($p in $table.Keys) {
    $f = Join-Path $root ($p.Replace('/', [IO.Path]::DirectorySeparatorChar))
    $run.checked++
    if (-not (Test-Path -LiteralPath $f)) { Add-Fail "missing: $p"; continue }
    $len = (Get-Item -LiteralPath $f).Length; $h = Get-Sha256 $f
    if ($len -ne $table[$p].bytes -or $h -ne $table[$p].sha) { Add-Fail "bytes differ: $p"; continue }
    $run.ok++
  }
} else {
  $u = [Uri]$BaseUrl
  $okHost = ($AllowedHosts -contains $u.Host) -or ($u.Host -match '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.azerdex-assets\.pages\.dev$')   # preview deployments of the project: read-only checks before the production upload
  $okBase = ($u.Scheme -eq 'https' -and $okHost -and $u.IsDefaultPort -and $u.AbsolutePath -eq '/' -and -not $u.Query -and -not $u.UserInfo)
  if (-not $okBase -and -not $AllowTestBase) { throw "Refusing base URL '$BaseUrl': https on an allow-listed host only ($($AllowedHosts -join ', '), or <deployment>.azerdex-assets.pages.dev)" }
  $base = $u.GetLeftPart([UriPartial]::Authority)
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('azerdex-cdn-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $n = 0; $unreachable = 0
  try {
    foreach ($p in $served) {
      $n++; if ($n % 20 -eq 0) { Write-Host ("  ... {0}/{1}" -f $n, $served.Count) }
      $run.checked++
      $dest = Join-Path $tmp 'f.bin'; if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
      $r = Invoke-Get "$base/$p" $dest
      $row = [ordered]@{ path = $p; status = $r.Status; sha256Ok = $false; headersOk = $true; cacheControl = $null; contentType = $null; cfCacheStatus = $null; server = $null }
      if ($r.Status -eq 0) { $unreachable++; Add-Fail "${p}: request failed ($($r.Error))"; $run.rows += $row; continue }
      if ($r.Status -ne 200) { Add-Fail "${p}: HTTP $($r.Status), expected 200"; $run.rows += $row; continue }
      $len = (Get-Item -LiteralPath $dest).Length; $h = Get-Sha256 $dest
      if ($len -ne $table[$p].bytes -or $h -ne $table[$p].sha) { Add-Fail "${p}: bytes differ from the audited distribution (got $len bytes, sha256 $h)" } else { $row.sha256Ok = $true }
      $row.cacheControl = Get-HeaderValue $r.Headers 'Cache-Control'; $row.contentType = Get-HeaderValue $r.Headers 'Content-Type'
      $row.cfCacheStatus = Get-HeaderValue $r.Headers 'CF-Cache-Status'; $row.server = Get-HeaderValue $r.Headers 'Server'
      $prefix = @($ExpectedHeaders.Keys | Where-Object { $p.StartsWith($_) })[0]
      foreach ($k in $ExpectedHeaders[$prefix].Keys) {
        $got = Get-HeaderValue $r.Headers $k
        if (-not (Test-HeaderEqual $k $got $ExpectedHeaders[$prefix][$k])) { $row.headersOk = $false; Add-Fail "${p}: header $k is '$got', expected '$($ExpectedHeaders[$prefix][$k])'" }
      }
      if ($p.EndsWith('.webp') -and $row.contentType -notmatch '^image/webp') { $row.headersOk = $false; Add-Fail "${p}: Content-Type '$($row.contentType)', expected image/webp" }
      if ($row.sha256Ok -and $row.headersOk) { $run.ok++ }
      $run.rows += $row
    }
    # paths that must NOT exist: a catch-all/SPA fallback would hide missing assets
    foreach ($p in $MissingProbes) {
      $r = Invoke-Get "$base/$p" (Join-Path $tmp 'probe.bin')
      $run.probes += [ordered]@{ path = $p; status = $r.Status; expected = 404 }
      if ($r.Status -ne 404) { Add-Fail "${p}: HTTP $($r.Status), expected 404 (a fallback page would hide missing assets)" }
    }
    $pre = @('zone-heroes/1424/v1/desktop-1280.webp')
    foreach ($p in $pre) {
      $r = Invoke-Get "$base/$p" (Join-Path $tmp 'probe.bin')
      $run.probes += [ordered]@{ path = $p; status = $r.Status; expected = $(if ($Mode -eq 'Baseline') { 404 } else { 200 }) }
      if ($Mode -eq 'Baseline' -and $r.Status -eq 200) { Add-Warn "$p is already served: the live CDN is NOT the atlas-only baseline (heroes already published?)" }
      if ($Mode -eq 'Baseline' -and $r.Status -ne 200 -and $r.Status -ne 404) { Add-Fail "${p}: unexpected HTTP $($r.Status)" }
    }
    $r = Invoke-Get "$base/_headers" (Join-Path $tmp 'probe.bin')
    $run.probes += [ordered]@{ path = '_headers'; status = $r.Status; expected = 'informational (Pages does not serve _headers)' }
    if ($r.Status -eq 200) { Add-Warn '/_headers is served as a file (Pages normally consumes it); informational' }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($unreachable -gt 0) { Add-Fail "$unreachable request(s) never reached the host: this is NOT a verification (network, proxy or DNS problem)" }
}

if ($run.checked -ne $(if ($Mode -eq 'Local') { $table.Count } else { $served.Count })) { Add-Fail "checked $($run.checked) files, expected $($served.Count)" }
$run.finishedUtc = (Get-Date).ToUniversalTime().ToString('o')
$run.verdict = if ($run.failures.Count -eq 0 -and $run.ok -eq $run.checked) { 'PASS' } else { 'FAIL' }
$run | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
Write-Host ''
Write-Host ("{0}: {1}/{2} files verified, {3} failure(s), {4} warning(s). Evidence: {5}" -f $run.verdict, $run.ok, $run.checked, $run.failures.Count, $run.warnings.Count, $EvidencePath)
if ($run.verdict -eq 'PASS') { exit 0 } else { exit 1 }
