@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo  C/C++ Pro - Local Development Installer
echo ===================================================

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
cd /d "%REPO_ROOT%"

REM Parse flags
set "DO_BUMP=1"
set "DO_BUILD=1"

for %%A in (%*) do (
    if /i "%%A"=="--no-bump" set "DO_BUMP=0"
    if /i "%%A"=="-NoBump" set "DO_BUMP=0"
    if /i "%%A"=="--skip-build" set "DO_BUILD=0"
    if /i "%%A"=="-SkipBuild" set "DO_BUILD=0"
)

REM 1. Check for npm
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: npm is not found in PATH.
    exit /b 1
)

REM 2. Locate VS Code executable (code, code-insiders, or codium)
set "CODE_BIN=code"
where code >nul 2>nul
if %ERRORLEVEL% neq 0 (
    where code-insiders >nul 2>nul
    if %ERRORLEVEL% equ 0 (
        set "CODE_BIN=code-insiders"
    ) else (
        where codium >nul 2>nul
        if %ERRORLEVEL% equ 0 (
            set "CODE_BIN=codium"
        ) else (
            echo Error: VS Code executable was not found in PATH.
            exit /b 1
        )
    )
)

REM 3. Bump patch version
if "%DO_BUILD%"=="1" (
    if "%DO_BUMP%"=="1" (
        echo [1/4] Bumping extension patch version...
        call node "%SCRIPT_DIR%bump-version.js"
        if !ERRORLEVEL! neq 0 (
            echo Error: Failed to bump version.
            exit /b !ERRORLEVEL!
        )
    ) else (
        echo [1/4] Skipping version bump: --no-bump requested...
    )
) else (
    echo [1/4] Skipping version bump: --skip-build requested...
)

REM 4. Package VSIX extension
if "%DO_BUILD%"=="1" (
    echo [2/4] Packaging VSIX bundle: clean, native Rust build, production esbuild...
    call npm run package
    if !ERRORLEVEL! neq 0 (
        echo Error: Failed to package VSIX bundle.
        exit /b !ERRORLEVEL!
    )
) else (
    echo [2/4] Skipping packaging step: --skip-build requested...
)

REM 5. Locate packaged VSIX extension
echo [3/4] Locating packaged VSIX extension...
set "VSIX_FILE="
for /f "delims=" %%F in ('dir /b /o:-d c-cpp-pro-*.vsix 2^>nul') do (
    set "VSIX_FILE=%%F"
    goto :found_vsix
)

:found_vsix
if "%VSIX_FILE%"=="" (
    echo Error: Could not locate packaged VSIX file in %REPO_ROOT%.
    exit /b 1
)

echo Target VSIX: %VSIX_FILE%

REM 6. Install VSIX into VS Code
echo [4/4] Installing %VSIX_FILE% into %CODE_BIN%...
call %CODE_BIN% --install-extension "%VSIX_FILE%" --force
if %ERRORLEVEL% neq 0 (
    echo Error: Failed to install VSIX into %CODE_BIN%.
    exit /b %ERRORLEVEL%
)

echo ---------------------------------------------------
echo Successfully installed %VSIX_FILE% into %CODE_BIN%.
echo To activate, reload your VS Code window: 'Developer: Reload Window'.
echo ---------------------------------------------------
exit /b 0
