# C/C++ Pro - Local Extension Builder & Installer
# Bumps version, builds native addon, compiles extension bundle, packages VSIX, and installs locally into VS Code.

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$NoBump,
    [switch]$PreRelease,
    [string]$CodeBin = "code"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir

Set-Location $RepoRoot

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host " C/C++ Pro - Local Development Installer" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# 1. Verify prerequisite tooling
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is not installed or not available in PATH."
}

$VscodeCli = Get-Command $CodeBin -ErrorAction SilentlyContinue
if (-not $VscodeCli) {
    # Check fallback editors: code-insiders, codium
    $FallbackCli = @("code", "code-insiders", "codium") | Where-Object { Get-Command $_ -ErrorAction SilentlyContinue } | Select-Object -First 1
    if ($FallbackCli) {
        $CodeBin = $FallbackCli
        $VscodeCli = Get-Command $CodeBin
        Write-Host "Using discovered VS Code CLI: $CodeBin" -ForegroundColor Yellow
    } else {
        Write-Error "VS Code executable ($CodeBin) not found in PATH. Please ensure 'code' command is in your PATH."
    }
}

# 2. Bump patch version
if (-not $NoBump -and -not $SkipBuild) {
    Write-Host "[1/4] Bumping extension patch version..." -ForegroundColor Green
    node (Join-Path $ScriptDir "bump-version.js")
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Version bump failed with exit code $LASTEXITCODE."
    }
} else {
    Write-Host "[1/4] Skipping version bump (NoBump or SkipBuild specified)..." -ForegroundColor Yellow
}

# 3. Package VSIX extension
if (-not $SkipBuild) {
    Write-Host "[2/4] Packaging VSIX bundle (clean, native Rust build, production esbuild)..." -ForegroundColor Green
    if ($PreRelease) {
        npm run package:pre
    } else {
        npm run package
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Packaging failed with exit code $LASTEXITCODE."
    }
} else {
    Write-Host "[2/4] Skipping build/packaging step (-SkipBuild requested)..." -ForegroundColor Yellow
}

# 4. Locate generated VSIX file
Write-Host "[3/4] Locating packaged VSIX extension..." -ForegroundColor Green
$VsixFile = Get-ChildItem -Path $RepoRoot -Filter "c-cpp-pro-*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $VsixFile -or -not (Test-Path $VsixFile.FullName)) {
    Write-Error "Could not find packaged VSIX file in $RepoRoot."
}

Write-Host "Target VSIX: $($VsixFile.Name) ($([math]::Round($VsixFile.Length / 1MB, 2)) MB)" -ForegroundColor Cyan

# 5. Install VSIX into VS Code
Write-Host "[4/4] Installing $($VsixFile.Name) into $CodeBin..." -ForegroundColor Green
& $CodeBin --install-extension $VsixFile.FullName --force

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install VSIX into VS Code (exit code $LASTEXITCODE)."
}

Write-Host "---------------------------------------------------" -ForegroundColor Cyan
Write-Host "Successfully installed $($VsixFile.Name) into $CodeBin." -ForegroundColor Green
Write-Host "To activate, reload your VS Code window: 'Developer: Reload Window' (Ctrl+R / Cmd+R)." -ForegroundColor Cyan
Write-Host "---------------------------------------------------" -ForegroundColor Cyan
