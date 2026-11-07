# Compiler & Toolchain Setup

C/C++ Pro features a zero-configuration compiler and SDK discovery engine. It detects installed toolchains, locates system include directories, probes third-party libraries, and synthesizes IntelliSense flags without requiring manual path configuration.

---

## 1. Supported Compilers & Discovery

C/C++ Pro automatically discovers native and cross-compilation toolchains on the host operating system:

| Compiler Family | Executables | Platform | Detection Mechanism |
| :--- | :--- | :--- | :--- |
| **MSVC** | `cl.exe` | Windows | `vswhere.exe`, Visual Studio 2017/2019/2022 installations, Build Tools |
| **LLVM Clang** | `clang++`, `clang`, `clang-cl` | Windows, Linux, macOS | `PATH`, standard LLVM directories (`C:\Program Files\LLVM\bin`, `/usr/bin`, Homebrew) |
| **GCC / MinGW** | `g++`, `gcc` | Windows, Linux, macOS | `PATH`, MinGW-w64, MSYS2 (`C:\msys64\mingw64\bin`), Linux system paths |
| **WSL Toolchains** | `wsl.exe g++`, `wsl.exe clang++` | Windows (WSL) | Discovered Linux distributions via WSL API |
| **Apple Clang** | `clang++`, `clang` | macOS | Xcode Command Line Tools (`/Library/Developer/CommandLineTools`) |

To manually trigger a scan for installed compilers:
1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
2. Run **`C/C++ Pro: Scan for Installed Compilers`** (`c-cpp-pro.detectCompilers`).
3. Results are displayed in the Output panel under the **C/C++ Pro** channel.

---

## 2. Compilation Flags Synthesis

For projects without formal build configurations (single-file scripts, unstructured directories, or scratchpads), C/C++ Pro synthesizes IntelliSense flags on the fly.

### Generating `compile_flags.txt`
1. Open the Command Palette.
2. Run **`C/C++ Pro: Generate compile_flags.txt`** (`c-cpp-pro.generateCompileFlags`).
3. C/C++ Pro writes a standard `compile_flags.txt` file into your workspace root configured with:
   - Appropriate language standard (`-std=c++20` or `-std=c17` based on your settings).
   - Resolved system include directories from the active compiler.
   - Detected external SDK include paths.

### Precedence Hierarchy
IntelliSense compilation flags are resolved in the following priority:
1. `compile_commands.json` (CMake, Visual Studio Solution, Bear, or Ninja).
2. `.clangd` configuration files (Workspace root or user home directory).
3. `compile_flags.txt` (Workspace root).
4. Auto-synthesized flags generated dynamically by C/C++ Pro.

---

## 3. External SDK & Ecosystem Discovery

C/C++ Pro automatically detects common system and graphics SDKs. To avoid flag pollution, C/C++ Pro verifies workspace source files via `ExternalSdkDetector.isSdkUsedInWorkspace` before injecting SDK include directories.

| SDK | Environment Variables | Default Filesystem Search Paths |
| :--- | :--- | :--- |
| **Vulkan SDK** | `VULKAN_SDK` | `C:\VulkanSDK\*`, `/usr/include/vulkan`, `/usr/local/include/vulkan` |
| **raylib** | `RAYLIB_DIR`, `RAYLIB_PATH` | `C:\raylib`, `/usr/local/include/raylib`, Homebrew paths |
| **CUDA Toolkit** | `CUDA_PATH` | `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\*`, `/usr/local/cuda` |
| **Boost C++** | `BOOST_ROOT`, `BOOST_DIR` | `C:\local\boost_*`, `/usr/include/boost`, Homebrew paths |
| **SDL2 / SDL3** | `SDL2_DIR`, `SDL3_DIR` | `C:\SDL*`, `/usr/include/SDL2`, `/usr/local/include/SDL2` |
| **Qt Framework** | `QTDIR`, `Qt6_DIR`, `Qt5_DIR`, `CMAKE_PREFIX_PATH` | `C:\Qt\<version>\<toolchain>`, `D:\Qt`, `/usr/include/qt6`, `/usr/include/qt5`, Homebrew |
| **Node-API** | — | Automatic inspection of `package.json` for `node-addon-api` or `nan` |
| **vcpkg** | `VCPKG_ROOT` | Automatic detection of active vcpkg installed directories |

### Intelligent Qt Toolchain Prioritization
When multiple Qt toolchains are installed (e.g. `android_arm64_v8a`, `mingw_64`, `msvc2022_64`):
- **Desktop Priority**: Cross-compilation kits (`android_*`, `wasm_*`, `ios`, `qnx_*`) are automatically deprioritized for desktop projects, ensuring desktop MinGW or MSVC headers are selected.
- **Compiler Affinity**: The toolchain matching your active compiler (MinGW/GCC vs MSVC) is automatically preferred based on workspace build files (`CMakeCache.txt`, `.sln`, `Makefile`) or system `PATH`.
- **Explicit Override**: You can explicitly select a specific Qt kit in settings:
  ```json
  {
    "c-cpp-pro.discovery.qtToolchain": "mingw_64"
  }
  ```

### Customizing SDK Probing
SDK auto-detection can be toggled in your VS Code settings:
```json
{
  "c-cpp-pro.discovery.detectExternalSdks": true
}
```

---

## 4. Visual Studio Developer Environment Injection (Windows)

When compiling or debugging with MSVC on Windows, environment variables (`INCLUDE`, `LIB`, `PATH`) must be initialized for `cl.exe` to find Windows SDK and CRT headers.

C/C++ Pro manages this environment automatically:
- **Set Environment**: Run **`C/C++ Pro: Set Visual Studio Developer Environment`** (`c-cpp-pro.setVsDeveloperEnvironment`) to choose an installed Visual Studio instance (x64, x86, or ARM64).
- **Environment Persistence**: Set `"c-cpp-pro.persistVsDeveloperEnvironment": true` to preserve the environment across editor sessions.
- **Terminal Overflow Protection**: C/C++ Pro de-duplicates PATH entries during injection to prevent Windows 32,767 character terminal buffer overflows.
- **Clear Environment**: Run **`C/C++ Pro: Clear Visual Studio Developer Environment`** (`c-cpp-pro.clearVsDeveloperEnvironment`) to reset back to system defaults.

---

## 5. Configuration Settings Reference

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `c-cpp-pro.clangdPath` | `string` | `""` | Path to `clangd` executable. If empty, searches `PATH` and auto-installed binary. |
| `c-cpp-pro.clangdArgs` | `array` | `[]` | Extra arguments passed to the `clangd` background process. |
| `c-cpp-pro.cppStandard` | `string` | `"c++20"` | Default C++ standard for flag synthesis (`c++98` through `c++26`). |
| `c-cpp-pro.cStandard` | `string` | `"c17"` | Default C standard for flag synthesis (`c89` through `c23`). |
| `c-cpp-pro.default.forcedInclude` | `array` | `[]` | Headers to force-include before compilation (`/FI` on MSVC, `-include` on GCC/Clang). |
| `c-cpp-pro.discovery.detectExternalSdks` | `boolean` | `true` | Auto-detect common external SDKs for IntelliSense fallback flags. |
| `c-cpp-pro.discovery.qtToolchain` | `string` | `""` | Preferred Qt toolchain kit subfolder (e.g. 'mingw_64', 'msvc2022_64', 'gcc_64'). Auto-detects if empty. |
