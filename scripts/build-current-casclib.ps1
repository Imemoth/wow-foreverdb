param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

$CascLibCommit = "2a280f5a231966dc5d1b534978dd9f9f04a374cd"
$CascLibPackageVersion = "1.50.0.206-alpha.3"

$workRoot = Join-Path $RepoRoot ".build"
$sourceDir = Join-Path $workRoot "CascLib"
$buildDir = Join-Path $sourceDir "build"

if (Test-Path $sourceDir) {
    Remove-Item $sourceDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $workRoot | Out-Null

Write-Host "Cloning CascLib at pinned commit $CascLibCommit..."
git clone --quiet https://github.com/ladislav-zezula/CascLib.git $sourceDir
git -C $sourceDir checkout --quiet $CascLibCommit

Write-Host "Configuring CascLib x64 shared library..."
$cmakeArgs = @(
    "-S", $sourceDir,
    "-B", $buildDir,
    "-A", "x64",
    "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    "-DCASC_BUILD_SHARED_LIB=ON",
    "-DCASC_BUILD_STATIC_LIB=OFF",
    "-DCASC_BUILD_TESTS=OFF"
)

& cmake @cmakeArgs

Write-Host "Building CascLib Release..."
cmake --build $buildDir --config Release

$builtDll = Join-Path $buildDir "Release\CascLib.dll"
if (-not (Test-Path $builtDll)) {
    throw "Built CascLib.dll not found at $builtDll"
}

$packageDll = Join-Path $env:USERPROFILE ".nuget\packages\casclib.net\$CascLibPackageVersion\runtimes\win-x64\native\CascLib.dll"

if (-not (Test-Path $packageDll)) {
    throw "CascLib.NET native DLL not found at $packageDll. Run dotnet restore first."
}

Copy-Item $builtDll $packageDll -Force

Write-Host "Replaced CascLib.NET bundled native DLL with upstream CascLib $CascLibCommit."
