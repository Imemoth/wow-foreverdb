# Black-box checks of the published ForeverDB.AtlasExporter.exe on Windows.
# Uses a SYNTHETIC client (tests/atlas-exporter --make-fixture): this proves the
# executable starts, loads CascLib/SkiaSharp, runs the CLI and produces a valid ZIP.
# It does NOT prove extraction from a real WoW: Forever install.
param(
    [Parameter(Mandatory)] [string]$Exe,
    [Parameter(Mandatory)] [string]$Fixture,
    [Parameter(Mandatory)] [string]$Work
)

$ErrorActionPreference = "Stop"
$Exe = (Resolve-Path $Exe).Path
$Fixture = (Resolve-Path $Fixture).Path
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Work = (Resolve-Path $Work).Path
$failures = @()

function Invoke-Exporter([string]$Name, [string[]]$Arguments) {
    $log = Join-Path $Work "$Name.log"
    & $Exe @Arguments *> $log
    $code = $LASTEXITCODE
    Write-Host "[$Name] exit $code"
    return @{ Code = $code; Log = (Get-Content $log -Raw) }
}

function Expect([string]$What, [bool]$Condition) {
    if ($Condition) { Write-Host "  ok   $What" }
    else { Write-Host "  FAIL $What"; $script:failures += $What }
}

$common = @(
    "--wow-root", $Fixture, "--csv-dir", (Join-Path $Fixture "csv"),
    "--loose-dir", (Join-Path $Fixture "assets"), "--no-network", "--metadata-source", "csv-dir"
)

$help = Invoke-Exporter "help" @("--help")
Expect "--help exits 0 and documents --wow-root" ($help.Code -eq 0 -and $help.Log -match "--wow-root")

$version = Invoke-Exporter "version" @("--version")
Expect "--version exits 0" ($version.Code -eq 0 -and $version.Log -match "Atlas Exporter")

$self = Invoke-Exporter "selfcheck" @("--selfcheck")
Expect "self-check loads CascLib and the WebP encoder" ($self.Code -eq 0 -and $self.Log -match "CascLib: loaded" -and $self.Log -match "WebP encoder: ok")

$bad = Invoke-Exporter "bad-option" @("--definitely-not-an-option")
Expect "unknown option is rejected (exit 1)" ($bad.Code -eq 1)

$noInstall = Invoke-Exporter "no-install" @("--wow-root", (Join-Path $Work "does-not-exist"), "--scan-only")
Expect "missing WoW folder gives exit 1 and an actionable message" ($noInstall.Code -eq 1 -and $noInstall.Log -match "build.info")

$noCasc = Invoke-Exporter "unreadable-casc" @("--wow-root", $Fixture, "--no-network", "--scan-only", "--output", (Join-Path $Work "casc-fail"))
Expect "an unreadable CASC store is a clear error, never an empty success" ($noCasc.Code -eq 1 -and $noCasc.Log -match "CASC")

$scanOut = Join-Path $Work "scan"
$scan = Invoke-Exporter "scan" ($common + @("--scan-only", "--output", $scanOut))
Expect "scan-only exits 0" ($scan.Code -eq 0)
Expect "scan reports 10 maps / 7 drawable" ($scan.Log -match "Maps discovered: 10" -and $scan.Log -match "Drawable \(own artwork\): 7")
Expect "scan-only exports nothing" (-not (Test-Path (Join-Path $scanOut "maps")))

$out = Join-Path $Work "export\ForeverDB-Atlas-Export"
$export = Invoke-Exporter "export" ($common + @("--export", "--output", $out))
Expect "export exits 0" ($export.Code -eq 0)
Expect "summary says COMPLETE" ($export.Log -match "Status: COMPLETE")

$zip = Join-Path (Split-Path $out -Parent) "ForeverDB-Atlas-Export-1.60.1.70245.zip"
Expect "ZIP created" (Test-Path $zip)

foreach ($file in @("atlas\index.json", "atlas\hierarchy.json", "atlas\build.json", "atlas\export-report.json",
        "diagnostics\export-summary.txt", "diagnostics\missing-maps.json", "gallery\index.html",
        "maps\1420\base\overview.webp", "maps\1420\base\manifest.json")) {
    Expect "output has $file" (Test-Path (Join-Path $out $file))
}

$index = Get-Content (Join-Path $out "atlas\index.json") -Raw | ConvertFrom-Json
Expect "index lists 10 maps" ($index.maps.Count -eq 10)
Expect "index counts 7 drawable" ($index.counts.drawableMaps -eq 7)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$names = $archive.Entries | ForEach-Object { $_.FullName }
$archive.Dispose()
Expect "ZIP has one ForeverDB-Atlas-Export root and no state files" (
    ($names | Where-Object { -not $_.StartsWith("ForeverDB-Atlas-Export/") }).Count -eq 0 -and
    ($names | Where-Object { $_ -match "\.state|\.tmp" }).Count -eq 0)

$verify = Invoke-Exporter "verify-zip" @("--verify", $zip)
Expect "--verify re-checks the delivered ZIP and finds it consistent" ($verify.Code -eq 0 -and $verify.Log -match "Export is consistent")

$resume = Invoke-Exporter "resume" ($common + @("--export", "--resume", "--output", $out))
Expect "resume exits 0 and reuses finished maps" ($resume.Code -eq 0 -and $resume.Log -match "reused 6")

$again = Invoke-Exporter "refuse-overwrite" ($common + @("--export", "--output", $out))
Expect "re-running without --resume/--force refuses to overwrite (exit 1)" ($again.Code -eq 1)

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "SMOKE FAILED:"
    $failures | ForEach-Object { Write-Host "  - $_" }
    exit 1
}

Write-Host ""
Write-Host "Smoke test passed (synthetic client)."
# Deliberate failing runs above leave $LASTEXITCODE at 1; do not let it leak out.
exit 0
