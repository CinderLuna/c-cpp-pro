# Visual Studio Solution Support

C/C++ Pro delivers native, static support for Visual Studio solutions and project files on Windows, Linux, and macOS. You can navigate, configure, and build enterprise Visual Studio codebases directly within Visual Studio Code without requiring the full Visual Studio IDE to be running.

---

## 1. Supported File Formats

C/C++ Pro statically parses both legacy and modern Visual Studio project files:

| Format | Extension | Description | Parser Implementation |
| :--- | :--- | :--- | :--- |
| **Traditional Solution** | `.sln` | Standard Visual Studio text format containing project GUIDs and configurations. | Native Rust parser (`crates/c-cpp-pro-native/src/solution.rs`) |
| **Modern Solution** | `.slnx` | Next-generation XML-based solution format introduced in Visual Studio 2022. | Native Rust parser (`quick-xml`) |
| **C++ Project** | `.vcxproj` | MSBuild XML project specification containing item groups, property sheets, and compile flags. | Native Rust parser (`quick-xml`) |

---

## 2. Static Parsing & Metadata Extraction

C/C++ Pro parses project definitions statically at native speeds without invoking `devenv.exe` or executing MSBuild:
- **Include Directories**: Resolves `AdditionalIncludeDirectories` across project properties and inherited property sheets (`.props`).
- **Preprocessor Definitions**: Extracts `PreprocessorDefinitions` per build configuration.
- **Language Standards**: Detects C++ standard (`/std:c++14`, `/std:c++17`, `/std:c++20`, `/std:c++latest`) and C standard (`/std:c11`, `/std:c17`).
- **Forced Includes**: Parses forced header dependencies (`/FI` or `<ForcedIncludeFiles>`).
- **Configuration & Platform Matrix**: Fully supports `Debug`, `Release`, `MinSizeRel`, and custom configurations across `x64`, `x86`, `ARM64`, and `ARM` platforms.

---

## 3. Compilation Database Generation

To bridge Visual Studio projects into `clangd`'s language server, C/C++ Pro generates a unified `compile_commands.json` compilation database:

1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
2. Run **`C/C++ Pro: Generate compile_commands.json from Solution`** (`c-cpp-pro.generateCompilationDbFromSolution`).
3. C/C++ Pro inspects all active `.vcxproj` project files and translates MSVC options into Clang driver mode flags (`--driver-mode=cl`, `/D`, `/I`, `/std:c++20`).
4. The synthesized compilation database is saved to the workspace root, immediately providing full semantic autocomplete, diagnostics, and navigation across the entire solution.

---

## 4. Solution Management & MSBuild Tasks

C/C++ Pro provides integrated commands and task runners to manage solutions:

### Commands
- **`C/C++ Pro: Select Active Solution (.sln / .slnx)`** (`c-cpp-pro.selectSolution`): Switch between multiple solution files present in the workspace.
- **`C/C++ Pro: Select Solution Configuration`** (`c-cpp-pro.selectSolutionConfiguration`): Switch active build configuration (e.g. `Debug|x64` to `Release|x64`).
- **`C/C++ Pro: Solution Actions Menu`** (`c-cpp-pro.solutionMenu`): Quick pick menu to build, clean, rebuild, or re-generate compilation databases.
- **`C/C++ Pro: Build Solution (MSBuild)`** (`c-cpp-pro.buildSolution`): Build the active solution using MSBuild.
- **`C/C++ Pro: Rebuild Solution (MSBuild)`** (`c-cpp-pro.rebuildSolution`): Clean and recompile all projects in the solution.
- **`C/C++ Pro: Clean Solution (MSBuild)`** (`c-cpp-pro.cleanSolution`): Remove build artifacts and intermediate files.

### MSBuild Task Provider
C/C++ Pro automatically registers an `msbuild` task definition for VS Code's Task runner (`Ctrl+Shift+B`):

```json
{
  "type": "msbuild",
  "solution": "${workspaceFolder}/MyProject.slnx",
  "configuration": "Debug",
  "platform": "x64",
  "target": "Build",
  "problemMatcher": "$msCompile"
}
```

---

## 5. Cross-Platform Solution Exploration

Because parsing is implemented natively without reliance on Windows COM APIs or the MSBuild executable, solution structure, include graphs, and `compile_commands.json` generation work seamlessly on **Linux** and **macOS**, allowing cross-compiling or remote inspection of Windows C++ projects.
