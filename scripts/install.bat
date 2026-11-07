@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo  C/C++ Pro - Local Development Installer
echo ===================================================

set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
cd /d "%REPO_ROOT%"

REM Check for npm
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: npm is not found in PATH.
    exit /b 1
)

REM Locate VS Code executable (code, code-insiders, or codium)
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
            echo Error: VS Code executable ^(code^) was not found in PATH.
            exit /b 1
        )
    )
)

echo [1/3] Packaging VSIX bundle (clean, native Rust build, production esbuild)...
call npm run package
if %ERRORLEVEL% neq 0 (
    echo Error: Failed to package VSIX bundle.
    exit /b %ERRORLEVEL%
)

echo [2/3] Locating packaged VSIX extension...
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

echo [3/3] Installing %VSIX_FILE% into %CODE_BIN%...
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
