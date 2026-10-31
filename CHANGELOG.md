# Changelog

All notable changes to the C/C++ Pro extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-10-31

### Fixed

- **External SDK & Third-Party Library Header Classification**:
  - Resolved classification bug where external SDK headers (Qt, Vulkan, raylib, Boost, SDL, CUDA, OpenCV, Eigen) were erroneously labeled as "C++ Standard Library" with broken `cppreference.com` URLs.
  - Implemented external SDK detection recognizing official frameworks, module categories, and accurate documentation links (Qt 6, Khronos Vulkan, raylib cheatsheet, Boost, SDL wiki, NVIDIA CUDA).
  - Added dedicated categorization and documentation links for Windows SDK (`KNOWN_WIN32_HEADERS` -> Microsoft Learn) and POSIX system headers (`KNOWN_POSIX_HEADERS` -> The Open Group Base Specifications).
  - Prioritized quoted workspace includes (`#include "..."`) over standard headers, ensuring local project files are not overshadowed by standard library documentation.
  - Safeguarded forwarding headers against false positives on small abstract interface headers defining classes, structs, or concepts.
  - Preserved clickable document links for local quoted project headers.

### Added

- **AI Agent Guidelines**:
  - Expanded `AGENTS.md` with complete native Rust addon architecture, external SDK classification constraints, path canonicalization, caching rules, and the automated `ship it` release workflow.

## [0.4.1] - 2026-10-31

### Fixed

- **Subfolder Header Include Resolution**:
  - Resolved an issue where files inside subdirectories (e.g. `src/application/Editing.cpp`) failed to resolve includes referencing their own parent segment (e.g. `#include "application/Editing.h"`).
  - Enhanced local header path resolution with redundant folder segment stripping and bounded upward workspace traversal.
  - Added native F12 definition provider fallback and clickable document links for `#include` directives.

- **CMake Transitive Target Linkage & Database Synthesis**:
  - Implemented `target_link_libraries` dependency extraction in both TypeScript and Rust native parsing engines.
  - Transitively propagates public include directories and preprocessor definitions across linked CMake targets.
  - Fixed forward-reference placeholder target merging across `add_subdirectory`.
  - Preserved target isolation in compilation database synthesis when global include directories are empty.

- **External SDK Detection & Qt Support**:
  - Added comprehensive Qt SDK detection supporting `QTDIR`, `Qt6_DIR`, `Qt5_DIR`, `CMAKE_PREFIX_PATH`, Windows standard locations, Linux multiarch, and macOS Homebrew.
  - Dynamically discovers Qt submodule include paths (`QtCore`, `QtGui`, `QtWidgets`, `QtNetwork`, `QtSql`, `QtSvg`, `QtQml`, `QtQuick`, `QtConcurrent`, `QtXml`).
  - Added `'playground'` directory exclusion to enforce strict verification sandbox isolation.

## [0.4.0] - 2026-10-03

### Fixed

- **Struct Member Variable Hover Layout Isolation**:
  - Resolved an issue where hovering over a struct type used as a member variable inside an enclosing class (e.g. `Rect` inside `class UIElement`) displayed the enclosing class layout instead of the member struct layout.
  - Enforced strict symbol and candidate name verification in AST memory layout resolution to prevent enclosing container scopes from leaking into member variable type hover cards.

- **Position-Targeted "Find References" in Hover Cards**:
  - Resolved an issue where clicking the "Find References" link in hover cards failed or operated at a stale cursor position.
  - Introduced the `c-cpp-pro.findReferences` command, encoding symbol coordinates into hover action links to ensure the editor caret navigates to the hovered symbol before initiating reference search.

### Changed

- Promoted `0.3.x` features to the official Stable Release channel following the Visual Studio Code Marketplace even-minor versioning convention.

## [0.3.0] - 2026-10-02

### Added

- **Project-Wide Reference Count CodeLens**:
  - Displays usage count directly above C++ classes, structs, member variables, functions, and methods across the workspace.
  - Interactive CodeLens click navigates directly to the symbol reference panel (`editor.action.findReferences`).
  - Added configuration settings:
    - `c-cpp-pro.referenceCount.enabled`: Toggles reference count CodeLens display on/off (default: `true`).
    - `c-cpp-pro.referenceCount.visibleSymbolKinds`: Filters which symbol kinds display reference counts (`class`, `struct`, `variable`, `function`, `method`).

- **Struct & Class Memory Layout & Alignment Inspection in Hover**:
  - Enriched hover card when hovering over `class`, `struct`, or `union` definitions and usages.
  - Displays total struct byte size, natural alignment, padding overhead percentage, and 64-byte cache line footprint.
  - Renders detailed field offset table showing byte offsets (`+0`, `+4`, `+8`), field sizes, member names, types, and padding indicators (`*padding* ░░`).
  - Implements field reordering recommendations that identify alignment waste and calculate optimal packed size.
  - Adds direct quick-action link to launch the dedicated Memory Layout Webview (`command:c-cpp-pro.inspectMemoryLayout`).
  - Multi-tier AST resolution resolving struct layout from active cursor location, document text lookup, or Clangd definition provider navigation into headers.

- **Win32 & Enum Memory Layout Heuristics**:
  - Added native and TypeScript support for Win32 types (`DWORD`, `WORD`, `BYTE`, `BOOL`, `HANDLE`, `HWND`, `HDC`, `HINSTANCE`) and ISO C++ character types (`char8_t`, `char16_t`, `char32_t`, `wchar_t`).
  - Added semantic heuristic mapping common enum and status types (`Type`, `Kind`, `Mode`, `State`, `Status`, `Action`, `Op`, `Code`, `Flag`, `Flags`) to 4-byte aligned types.
  - Added brace matching and body parser handling inline methods, access specifiers (`public:`, `private:`), default initializers (`= 0.0`), uniform initializers (`{0}`), and C++ attributes (`[[no_unique_address]]`, `alignas(...)`).

### Changed

- **Clean Declaration Headings**:
  - Sanitized Clangd hover headers by stripping raw namespace comments (`// In namespace ...`) from code blocks and displaying clean badges (`### struct Name *(in namespace ide)*`).

- **Native Rust Engine Alignment**:
  - Synchronized Rust native acceleration crate (`c-cpp-pro-native`) memory layout parser with the TypeScript fallback engine for parity across all supported platforms.

### Fixed

- **Visual Studio Marketplace Extension Icon**:
  - Configured top-level icon field in `package.json` pointing to `media/icon.png` to resolve marketplace gallery display issues.

- **VSIX Packaging Sanitization**:
  - Updated `.vscodeignore` to exclude local test harnesses, scratch files, and development artifacts from production `.vsix` packages.

---

## [0.2.1] - 2026-09-27

### Changed

- Configured extension marketplace icon metadata.
- Staged multi-platform native library targets for Windows, Linux, and macOS.

### Fixed

- Resolved Unix native library naming conventions (`libc_cpp_pro_native.so`, `libc_cpp_pro_native.dylib`).

---

## [0.2.0] - 2026-09-27

### Added

- **Static CMake Parser & Include Extractor**:
  - Static tokenization and AST parsing of `CMakeLists.txt` files without invoking external CMake binaries.
  - Extraction of target include directories, definitions, and compilation parameters.
  - Standalone `compile_commands.json` database generation for CMake projects.

- **Visual Studio Solution Parser**:
  - Static parsing of `.sln`, `.slnx`, and `.vcxproj` files to generate compilation databases for MSVC workspaces.

- **Multi-Target Kconfig Profile Support**:
  - Profile and target switcher supporting Linux kernel-style `.config` files.

---

## [0.1.1] - 2026-09-27

### Added

- **C/C++ Project Scaffolding Wizard**:
  - Interactive multi-platform project creation command (`c-cpp-pro.createProject`) supporting Windows, Linux, and macOS.
  - Template scaffolding for Console, Static Library, Shared Library, and GUI applications with CMake or raw compile flags.

- **Documentation & Wiki Integration**:
  - Comprehensive command palette references, configuration guides, and architecture documentation.

---

## [0.1.0] - 2026-09-26

### Added

- **LLVM Clangd Language Server Substrate**:
  - High-performance Clangd lifecycle management, automatic toolchain detection, and background indexing.
- **Intelligent Semantic Completions**:
  - Rich ISO C++ Standard Library documentation, complexity annotations, exception safety guarantees, and iterator invalidation rules.
- **Native Debugger Integration (DAP Engine)**:
  - Automated debug configuration generation and launch resolution for LLDB and GDB.
- **Compiler Prober & Flag Synthesizer**:
  - System compiler discovery across MSVC, GCC, and Clang toolchains.
- **Memory Layout & Include Analysis**:
  - Struct layout visualization and `-ftime-trace` compile time flamegraph analysis.
