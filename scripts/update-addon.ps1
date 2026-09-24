param(
    [string]$AddOnsPath
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AddonSource = Join-Path $RepoRoot "addon\ForeverDB"

if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
    Write-Host "ERROR: This folder is not a Git clone." -ForegroundColor Red
    Write-Host "Clone the repository first, then run this script again."
    exit 1
}

Write-Host "Updating ForeverDB repository..." -ForegroundColor Cyan
git -C $RepoRoot pull --ff-only origin main

if ($LASTEXITCODE -ne 0) {
    throw "git pull failed."
}

if (-not (Test-Path $AddonSource)) {
    throw "Addon source folder not found: $AddonSource"
}

if (-not $AddOnsPath) {
    $candidates = @(
        (Join-Path $env:USERPROFILE "World of Warcraft\_classic_beta_\Interface\AddOns"),
        "C:\Program Files (x86)\World of Warcraft\_classic_beta_\Interface\AddOns",
        "C:\Program Files\World of Warcraft\_classic_beta_\Interface\AddOns"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            $AddOnsPath = $candidate
            break
        }
    }
}

if (-not $AddOnsPath -or -not (Test-Path $AddOnsPath)) {
    Write-Host ""
    Write-Host "WoW Forever AddOns folder was not found automatically." -ForegroundColor Yellow
    Write-Host ""
    $manualPath = Read-Host "Paste the AddOns folder path, or press Enter to cancel"

    if ($manualPath) {
        $manualPath = $manualPath.Trim('"')
        if (Test-Path $manualPath) {
            $AddOnsPath = $manualPath
        }
    }
}

if (-not $AddOnsPath -or -not (Test-Path $AddOnsPath)) {
    Write-Host ""
    Write-Host "No valid AddOns folder selected." -ForegroundColor Red
    Write-Host "Example:"
    Write-Host '.\scripts\update-addon.ps1 -AddOnsPath "C:\Users\Imemoth\World of Warcraft\_classic_beta_\Interface\AddOns"'
    exit 2
}

$AddonDestination = Join-Path $AddOnsPath "ForeverDB"

Write-Host ""
Write-Host "Installing addon to:" -ForegroundColor Cyan
Write-Host $AddonDestination

if (Test-Path $AddonDestination) {
    Remove-Item $AddonDestination -Recurse -Force
}

Copy-Item $AddonSource $AddonDestination -Recurse -Force

Write-Host ""
Write-Host "ForeverDB updated and installed successfully." -ForegroundColor Green
Write-Host "Restart WoW or use /reload if the client is already running."
