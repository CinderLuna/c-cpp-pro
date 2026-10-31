# AGENTS.md

Instructions and guidelines for AI agents working in the C/C++ Pro codebase.

## 1. Project Overview

C/C++ Pro is a high-performance C/C++ extension for Visual Studio Code. It integrates LLVM Clangd, compiler discovery, static build system analysis, native debugging, and native Rust-accelerated symbol processing.

- **Repository**: [https://github.com/CinderLuna/c-cpp-pro](https://github.com/CinderLuna/c-cpp-pro)

### Core Architecture

- **`src/substrate/`**: Manages the `clangd` language server process, status bar, and communication protocols.
- **`src/prober/`**: Discovers system compilers (MSVC, GCC, Clang) and external SDKs (Vulkan, raylib, CUDA, Boost, SDL).
- **`src/cmake/`**: Statically tokenizes and parses `CMakeLists.txt` files without invoking external CMake binaries.
- **`src/solution/`**: Statically parses Visual Studio solutions (`.sln`, `.slnx`, `.vcxproj`) to generate compilation databases.
- **`src/config/`**: Manages multi-target profiles and Kconfig (`.config`) files.
- **`src/debugger/`**: Manages debug configurations, process attachment, and DAP sessions.
- **`src/intelligence/`**: Implements smart definition navigation, code actions, document links, and header hovers.
- **`src/webview/`**: Provides the interactive configuration panel webview.
- **`native/`**: Houses the native Rust addon for high-performance symbol indexing, AST parsing, and cache acceleration.

---

## 2. Essential Commands

Execute commands in the workspace root directory:

1. **Build extension bundle**:
   ```bash
   npm run build
   ```
2. **Build native Rust addon**:
   ```bash
   npm run build:native
   ```
3. **Watch for incremental changes**:
   ```bash
   npm run watch
   ```
4. **Run TypeScript typecheck**:
   ```bash
   npm run check-types
   ```
5. **Run unit tests**:
   ```bash
   npm test
   ```
6. **Package VSIX extension**:
   ```bash
   npm run package
   ```
7. **Install packaged VSIX locally**:
   ```bash
   code --install-extension c-cpp-pro-<version>.vsix --force
   ```

---

## 3. Strict TypeScript and Code Integrity Rules

The project enforces the strictest TypeScript compiler options in [`tsconfig.json`](tsconfig.json):

1. **No Implicit Any**: Specify explicit types for all variables, parameters, and return values.
2. **Strict Null Checks**: Handle `null` and `undefined` explicitly. Do not use non-null assertions (`!`) carelessly.
3. **No Unused Code**: Do not leave unused imports, variables, or functions.
4. **Unused Parameters**: Prefix intentionally unused callback parameters with an underscore (e.g., `_token`).
5. **No Implicit Returns**: Ensure all code paths in non-void functions return a value.
6. **No Fallthrough in Switch**: End every non-empty case statement with `break` or `return`.
7. **No Unreachable Code**: Remove dead code paths and unused labels immediately.
8. **Explicit Overrides**: Use the `override` keyword when overriding base class methods.
9. **Zero Type Errors**: Always run `npm run check-types` before submitting any changes.
10. **Strict No Emojis**: Do not use emojis in code, comments, documentation, commit messages, or communication.

---

## 4. Key Engineering Constraints

Adhere strictly to these constraints when modifying the codebase:

### External SDK Discovery & Classification
- Do not inject external SDK flags into projects that do not use them.
- Verify workspace usage via `ExternalSdkDetector.isSdkUsedInWorkspace` before adding SDK include directories.
- Distinguish ISO C++, C standard library, Windows SDK, and POSIX headers from third-party libraries (Qt, Vulkan, raylib, Boost, SDL, CUDA, OpenCV, Eigen).
- Never classify external SDKs or third-party libraries as C/C++ Standard Library.
- Never generate cppreference documentation links for non-standard libraries.
- Forwarding headers must only be followed if they contain no class, struct, enum, concept, or function definitions.

### Platform Agnosticism & Path Handling
- Always canonicalize file paths for case-insensitive comparison on Windows (`canonicalizePath`).
- Handle Windows drive letters, path separators, and casing consistently across all modules.
- Ensure all file URIs for VS Code API calls use normalized paths.

### Performance & Cache Hygiene
- Keep in-memory caches bounded using an LRU eviction strategy (e.g., `MAX_HEADER_CACHE_SIZE`).
- Cache expensive filesystem scans (such as SDK include directories) with a reasonable TTL (e.g., 30 seconds).
- Do not perform synchronous filesystem traversals inside interactive request handlers (hover, completion, links).

### Test Hygiene & Resource Cleanup
- Wrap all temporary test directory creations and file manipulations in `try ... finally` blocks.
- Ensure all test artifacts clean up after execution even if assertions fail.
- Do not use redundant `await` on synchronous functions in tests.

### Playground Directory Isolation
- **Never traverse, list, or search the `playground/` directory**:
  - Do not run `ls`, `dir`, `Get-ChildItem`, `find`, or recursive glob searches targeting `playground/`.
  - Do not read, edit, or commit files within `playground/` unless the user explicitly targets a specific sub-path in a prompt.
  - Keep `playground/` strictly isolated as an external manual verification sandbox.
  - The `playground/` directory itself is tracked via `.gitkeep`, but all repository contents inside it are ignored by git.

### Strict No Emojis Rule
- Do not use emojis in source code, UI messages, diagnostics, comments, documentation, commit messages, or agent communication. Maintain a clean, professional, and technical tone throughout.

---

## 5. Release Workflow (`ship it`)

When the user specifies `ship it`, execute the following sequential release process:

1. **Increment Version**:
   - Increment the patch version in `package.json` (e.g., from `0.4.1` to `0.4.2`), unless the user explicitly specifies a minor or major release.
2. **Update Changelog**:
   - Add a new section to `changelog.md` summarizing the changes, bug fixes, and features under the new version header with the current date.
3. **Typecheck & Test**:
   - Run `npm run check-types` and ensure zero errors.
   - Run `npm test` and ensure all unit tests pass.
4. **Compile & Package**:
   - Run `npm run package` to compile the extension bundle, native addon, and generate the `.vsix` file.
5. **Git Commit & Tag**:
   - Stage all changed files: `git add .`
   - Commit with a standard technical commit message (e.g., `git commit -m "Release vX.Y.Z: <summary of changes>"`). Do not include emojis.
   - Create an annotated git tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
6. **Push to Remote**:
   - Push the branch and tags to the remote repository: `git push origin <branch> --follow-tags`
7. **Report Completion**:
   - Provide the user with the new version number, packaged VSIX filename, and commit hash.

---

## 6. Verification Checklist

Complete these steps for every change before committing:

1. Run `npm run check-types` and verify 0 type errors.
2. Run `npm test` and verify all unit tests pass.
3. Verify `git status` shows no unintended or untracked files.
4. Verify no emojis are present in changed files or commit messages.
