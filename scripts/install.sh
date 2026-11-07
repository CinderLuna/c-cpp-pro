#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "==================================================="
echo " C/C++ Pro - Local Development Installer"
echo "==================================================="

# Parse flags
DO_BUMP=1
DO_BUILD=1

for arg in "$@"; do
    case "${arg}" in
        --no-bump|-NoBump)
            DO_BUMP=0
            ;;
        --skip-build|-SkipBuild)
            DO_BUILD=0
            ;;
        *)
            ;;
    esac
done

# 1. Verify npm presence
if ! command -v npm &>/dev/null; then
    echo "Error: npm is not installed or not available in PATH." >&2
    exit 1
fi

# 2. Locate VS Code CLI executable
CODE_BIN="code"
if ! command -v "${CODE_BIN}" &>/dev/null; then
    if command -v code-insiders &>/dev/null; then
        CODE_BIN="code-insiders"
    elif command -v codium &>/dev/null; then
        CODE_BIN="codium"
    else
        echo "Error: VS Code executable ('code') not found in PATH." >&2
        exit 1
    fi
fi

# 3. Bump patch version
if [ "${DO_BUILD}" -eq 1 ]; then
    if [ "${DO_BUMP}" -eq 1 ]; then
        echo "[1/4] Bumping extension patch version..."
        node "${SCRIPT_DIR}/bump-version.js"
    else
        echo "[1/4] Skipping version bump (--no-bump requested)..."
    fi
else
    echo "[1/4] Skipping version bump (--skip-build requested)..."
fi

# 4. Package extension VSIX
if [ "${DO_BUILD}" -eq 1 ]; then
    echo "[2/4] Packaging VSIX bundle (clean, native Rust build, production esbuild)..."
    npm run package
else
    echo "[2/4] Skipping build/packaging step (--skip-build requested)..."
fi

# 5. Locate the latest generated VSIX file
echo "[3/4] Locating packaged VSIX extension..."
VSIX_FILE=$(ls -t c-cpp-pro-*.vsix 2>/dev/null | head -n 1 || true)

if [ -z "${VSIX_FILE}" ] || [ ! -f "${VSIX_FILE}" ]; then
    echo "Error: Could not find packaged VSIX file in ${REPO_ROOT}." >&2
    exit 1
fi

echo "Target VSIX: ${VSIX_FILE}"

# 6. Install VSIX into VS Code
echo "[4/4] Installing ${VSIX_FILE} into ${CODE_BIN}..."
"${CODE_BIN}" --install-extension "${VSIX_FILE}" --force

echo "---------------------------------------------------"
echo "Successfully installed ${VSIX_FILE} into ${CODE_BIN}."
echo "To activate, reload your VS Code window: 'Developer: Reload Window'."
echo "---------------------------------------------------"
