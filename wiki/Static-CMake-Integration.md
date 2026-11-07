# CMake Integration & Modern Tooling

C/C++ Pro features a hybrid CMake intelligence engine that combines instantaneous, zero-binary static parsing of `CMakeLists.txt` with full ingestion of modern CMake FileAPI (`codemodel-v2`), CMake Presets, target debugging, and CTest integration.

---

## 1. Hybrid CMake Architecture

C/C++ Pro implements a dual-mode hybrid architecture:

1. **Modern CMake FileAPI Ingestion (Default for Configured Workspaces)**:
   - When a project has been configured (e.g. in `build/` or an active preset binary directory), C/C++ Pro automatically detects and ingests CMake FileAPI artifacts (`.cmake/api/v1/reply/`):
     - `codemodel-v2`: Exact compilation flags, target definitions, sysroots, include directories, and preprocessor definitions.
     - `cache-v2`: Full cache variables and entry metadata.
     - `toolchains-v1`: Extracted compiler paths, versions, and target architecture triples.
   - Watches `.cmake/api/v1/reply/` to automatically update IntelliSense when external CMake builds run.

2. **Zero-Binary Static AST Parser (Fallback & Unconfigured Projects)**:
   - If CMake has not yet run or no build tree exists, C/C++ Pro's high-throughput Rust parser (`crates/c-cpp-pro-native/src/cmake.rs`) parses `CMakeLists.txt` files and `.cmake` modules directly in memory in milliseconds.
   - Semantic autocomplete, include paths, and error checking work the moment you open a CMake workspace, even before any build directory exists.

---

## 2. CMake Presets Support

C/C++ Pro supports `CMakePresets.json` and `CMakeUserPresets.json` (schema versions 1 through 9+):
- **Configure Presets**: Evaluates generator, binary directory, cache variables, toolchain files, and environment definitions.
- **Build Presets**: Evaluates target sets, jobs, and build options.
- **Test Presets**: Connects test filters and timeouts to CTest.
- **Macro Expansions**: Supports standard CMake macros (`${sourceDir}`, `${presetName}`, `${generator}`, `${hostSystemName}`, `${env:VAR}`).
- **Preset Switching**: Use the Command Palette to select configure presets via **`C/C++ Pro: Select CMake Configure Preset`** (`c-cpp-pro.cmake.selectConfigurePreset`) or build presets via **`C/C++ Pro: Select CMake Build Preset`** (`c-cpp-pro.cmake.selectBuildPreset`).

---

## 3. Target-Aware Launch & Debug Engine

C/C++ Pro extracts executable targets directly from CMake FileAPI and static declarations:
- **Active Target Selection**: Click the **Target** widget on the status bar or run **`C/C++ Pro: Select Active CMake Launch Target`** (`c-cpp-pro.cmake.selectLaunchTarget`).
- **Debugging**: Run **`C/C++ Pro: Debug Active CMake Target`** (`c-cpp-pro.cmake.debugTarget`) to immediately launch the target under C/C++ Pro's DAP engine (`lldb-dap`, `cppvsdbg`, or `gdb`) without authoring a manual `launch.json`.
- **Run Without Debugging**: Run **`C/C++ Pro: Run Active CMake Target`** (`c-cpp-pro.cmake.launchTarget`) to execute the target inside the integrated terminal.

---

## 4. CTest Integration in Test Explorer

CTest suites are discovered and displayed alongside source-scanned unit tests (GoogleTest, Catch2, Boost.Test, doctest) in the unified VS Code Test Explorer (`vscode.tests`):
- Discovers tests via `ctest --show-only=json-v1` or by parsing `CTestTestfile.cmake`.
- Supports Run and Debug profiles directly from the Test Explorer interface.
- Streams live test execution output and failure diagnostics into the Test Results pane.

---

## 5. Single-File Quick Compilation

Quickly verify syntax, template instantiations, and compiler diagnostics for the active source file without triggering full project linkage:
- Right-click in the editor and select **`C/C++ Pro: Compile Active File (Syntax & Diagnostics)`** (`c-cpp-pro.cmake.compileActiveFile`).
- Resolves the exact compile command from `compile_commands.json` or synthesized flags.
- Spawns the compiler in compile/syntax-only mode (`-fsyntax-only` / `/Zs`) and streams warnings and errors directly into the Problems panel using streaming problem matchers.

---

## 6. AST-Assisted "Add File to CMakeLists.txt" Refactoring

When creating new `.cpp` or `.h` files:
- C/C++ Pro detects if the file is not yet tracked in `CMakeLists.txt`.
- A Refactor Quick Fix appears: **`C/C++ Pro: Add to CMake target '<targetName>'`**.
- Automatically inserts the source path into `target_sources()`, `add_executable()`, or `add_library()` preserving indentation and whitespace formatting.

---

## 7. CMakeLists.txt Language IntelliSense

C/C++ Pro provides native offline language intelligence for `CMakeLists.txt` and `*.cmake` files:
- **Autocompletion**:
  - Over 130 CMake commands with parameter snippets (`add_executable`, `target_include_directories`, `target_link_libraries`, `find_package`, etc.).
  - Over 1,300 built-in CMake variables (`CMAKE_CXX_STANDARD`, `CMAKE_BUILD_TYPE`, `CMAKE_CURRENT_SOURCE_DIR`, `BUILD_SHARED_LIBS`, etc.).
  - Scoping keywords: `PUBLIC`, `PRIVATE`, `INTERFACE`, `REQUIRED`, `COMPONENTS`, `STATIC`, `SHARED`, `MODULE`, `CONFIG`, `WIN32`.
- **Hover Documentation**:
  - Hovering over commands displays command signatures, parameter descriptions, and official syntax examples.
  - Hovering over variables displays their purpose, default values, and valid settings.

---

## 8. Editor Run Button Options for Project Files

When a project file is focused in the editor (`CMakeLists.txt`, `*.cmake`, `.sln`, `.slnx`, `.vcxproj`), the Run button in the top-right editor title bar provides one-click project actions:
- **Build & Run Project** (`c-cpp-pro.buildAndRunProject`): Automatically builds the project and launches the active target binary in the integrated terminal.
- **Build Project** (`c-cpp-pro.buildProject`): Configures and runs `cmake --build` (or MSBuild for solutions) with real-time error streaming into the Problems tab.
- **Build & Debug Project** (`c-cpp-pro.buildAndDebugProject`): Automatically builds the project and attaches C/C++ Pro's DAP debugger (`lldb-dap`, `cppvsdbg`, or `gdb`).

---

## 9. CMake Commands Reference

| Command | Identifier | Action |
| :--- | :--- | :--- |
| **CMake Intelligence Menu** | `c-cpp-pro.cmake.menu` | Opens a quick-pick popup with all CMake actions, targets, and presets. |
| **Build Project** | `c-cpp-pro.buildProject` | Configure and compile the entire project. |
| **Build & Run Project** | `c-cpp-pro.buildAndRunProject` | Build the project and run the active executable target. |
| **Build & Debug Project** | `c-cpp-pro.buildAndDebugProject` | Build the project and attach the debugger to the active target. |
| **Select Configure Preset** | `c-cpp-pro.cmake.selectConfigurePreset` | Switch active configure preset from `CMakePresets.json`. |
| **Select Build Preset** | `c-cpp-pro.cmake.selectBuildPreset` | Switch active build preset from `CMakePresets.json`. |
| **Select Launch Target** | `c-cpp-pro.cmake.selectLaunchTarget` | Switch the active executable target for run and debug. |
| **Debug Active CMake Target** | `c-cpp-pro.cmake.debugTarget` | Start DAP debugging for the active target binary. |
| **Run Active CMake Target** | `c-cpp-pro.cmake.launchTarget` | Run the active target binary in the integrated terminal. |
| **Compile Active File** | `c-cpp-pro.cmake.compileActiveFile` | Quick syntax and diagnostic check for active C/C++ file. |
| **Re-scan CMakeLists.txt Includes** | `c-cpp-pro.cmake.rescan` | Manually triggers a re-parse of workspace `CMakeLists.txt` files. |
| **Generate Compilation Database** | `c-cpp-pro.cmake.generateCompilationDatabase` | Synthesizes `compile_commands.json` from parsed CMake targets. |
