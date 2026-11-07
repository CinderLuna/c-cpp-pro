# Static CMake Integration

C/C++ Pro features a static CMake intelligence engine that parses `CMakeLists.txt` files and `.cmake` modules directly in memory without requiring the `cmake` binary, configuration directories, or build trees.

---

## 1. Why Static CMake Parsing?

Traditional CMake extensions require configuring and generating a complete build directory (`build/` or `out/`) before IntelliSense becomes functional. This requires installed dependencies, functional toolchain files, and significant disk and CPU overhead.

C/C++ Pro's static CMake engine provides:
- **Instant IntelliSense**: Semantic autocomplete and error checking work the moment you open a CMake workspace.
- **No External Binaries**: Operates completely independently of the `cmake` executable or ninja/make generators.
- **Zero Disk Bloat**: Extracts compile flags, definitions, and include directories without generating build trees.
- **Native Performance**: Powered by a high-throughput Rust parser (`crates/c-cpp-pro-native/src/cmake.rs`) that processes thousands of lines in milliseconds.

---

## 2. Supported CMake Commands & Semantics

The static parser recognizes and models the core CMake target model:

| Command | Modeling & Extraction |
| :--- | :--- |
| `project(...)` | Workspace naming and language configuration (`C`, `CXX`). |
| `set(VAR ...)` | Variable assignment and dynamic variable expansion (`${VAR}`). |
| `include_directories(...)` | Workspace-global include directories. |
| `add_definitions(...)` | Workspace-global preprocessor defines (`-DFOO`). |
| `add_executable(target ...)` | Executable target definition and source file association. |
| `add_library(target ...)` | Static, Shared, Module, and Interface library definitions. |
| `target_include_directories(...)` | Per-target include paths with `PUBLIC`, `PRIVATE`, or `INTERFACE` visibility. |
| `target_compile_definitions(...)` | Per-target preprocessor defines with visibility scoping. |
| `target_sources(...)` | Associating source files with existing targets. |
| `target_link_libraries(...)` | Dependency modeling and transitive include/define propagation. |
| `add_subdirectory(...)` | Recursive traversal and parsing of sub-projects. |
| `include(...)` | Inlining and parsing external `.cmake` modules. |

### Generator Expression Handling
C/C++ Pro automatically evaluates build-time generator expressions:
- **Unwraps**: `$<BUILD_INTERFACE:path>` is unwrapped and included in IntelliSense paths.
- **Discards**: `$<INSTALL_INTERFACE:path>` is ignored to reflect active in-source development paths.

---

## 3. Automatic Compilation Database Synthesis

C/C++ Pro can automatically synthesize a complete `compile_commands.json` compilation database directly from your CMake targets:

1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
2. Run **`C/C++ Pro: Generate compile_commands.json from CMakeLists.txt`** (`c-cpp-pro.cmake.generateCompilationDatabase`).
3. C/C++ Pro compiles target sources and isolated private/public includes into a standards-compliant compilation database.
4. Language standards are tailored per source file:
   - C files (`.c`) receive pure C standards (`-std=c17`, `clang`).
   - C++ files (`.cpp`, `.cxx`, `.cc`) receive C++ standards (`-std=c++20`, `clang++`).

---

## 4. CMake Commands Reference

| Command | Identifier | Action |
| :--- | :--- | :--- |
| **CMake Intelligence Menu** | `c-cpp-pro.cmake.menu` | Opens a quick-pick popup with available CMake actions. |
| **Re-scan CMakeLists.txt Includes** | `c-cpp-pro.cmake.rescan` | Manually triggers a re-parse of all workspace `CMakeLists.txt` files. |
| **Generate Compilation Database** | `c-cpp-pro.cmake.generateCompilationDatabase` | Synthesizes `compile_commands.json` from parsed CMake targets. |

---

## 5. Configuration Settings

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `c-cpp-pro.cmake.autoScan` | `boolean` | `true` | Automatically parse `CMakeLists.txt` on folder open and file save. |
| `c-cpp-pro.cppStandard` | `string` | `"c++20"` | C++ standard emitted for synthesized CMake compile commands. |
| `c-cpp-pro.cStandard` | `string` | `"c17"` | C standard emitted for synthesized CMake compile commands. |
