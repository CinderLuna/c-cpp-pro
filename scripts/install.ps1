# C/C++ Pro - Local Extension Builder & Installer
# Builds the native addon, compiles extension bundle, packages VSIX, and installs locally into VS Code.

[CmdletBinding()]
param(
    [switch]$SkipBuild,
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

# 2. Package VSIX extension
if (-not $SkipBuild) {
    Write-Host "[1/3] Packaging VSIX bundle (clean, native Rust build, production esbuild)..." -ForegroundColor Green
    if ($PreRelease) {
        npm run package:pre
    } else {
        npm run package
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Packaging failed with exit code $LASTEXITCODE."
    }
} else {
    Write-Host "[1/3] Skipping build/packaging step (-SkipBuild requested)..." -ForegroundColor Yellow
}

# 3. Locate generated VSIX file
Write-Host "[2/3] Locating packaged VSIX extension..." -ForegroundColor Green
$VsixFile = Get-ChildItem -Path $RepoRoot -Filter "c-cpp-pro-*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $VsixFile -or -not (Test-Path $VsixFile.FullName)) {
    Write-Error "Could not find packaged VSIX file in $RepoRoot."
}

Write-Host "Target VSIX: $($VsixFile.Name) ($([math]::Round($VsixFile.Length / 1MB, 2)) MB)" -ForegroundColor Cyan

# 4. Install VSIX into VS Code
Write-Host "[3/3] Installing $($VsixFile.Name) into $CodeBin..." -ForegroundColor Green
& $CodeBin --install-extension $VsixFile.FullName --force

if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to install VSIX into VS Code (exit code $LASTEXITCODE)."
}

Write-Host "---------------------------------------------------" -ForegroundColor Cyan
Write-Host "Successfully installed $($VsixFile.Name) into $CodeBin." -ForegroundColor Green
Write-Host "To activate, reload your VS Code window: 'Developer: Reload Window' (Ctrl+R / Cmd+R)." -ForegroundColor Cyan
Write-Host "---------------------------------------------------" -ForegroundColor Cyan
