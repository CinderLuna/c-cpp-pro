# Debugging Guide

C/C++ Pro includes a native Debug Adapter Protocol (DAP) debugging engine (`c-cpp-pro-debug`). It delivers zero-setup, open-standard C/C++ debugging across **Windows**, **Linux**, and **macOS** using modern backends without proprietary extensions or vendor lock-in.

---

## 1. Supported Debugger Backends

C/C++ Pro automatically detects, configures, and connects to installed debugging backends:

| Backend | Platform | Protocol | Best Suited For |
| :--- | :--- | :--- | :--- |
| **`lldb-dap`** | Windows, Linux, macOS | Native DAP | LLVM Clang, Apple Clang, and modern cross-platform projects. |
| **GDB** | Linux, Windows (MinGW/WSL) | Native DAP (`--interpreter=dap`) | GCC, MinGW-w64, Linux kernel, and embedded projects. |
| **MSVC Native** | Windows | Win32 Debug API | Microsoft Visual C++ (`cl.exe`) binaries and PDB debugging. |

---

## 2. Quick Run & Debug (Title Bar Actions)

C/C++ Pro adds one-click Run and Debug actions to the editor title bar for active C and C++ source files:

- **Run C/C++ File** (`c-cpp-pro.runFile`): Compiles the active file with detected compiler flags and launches the output in the integrated terminal. On Windows, automatically initializes the Visual Studio Developer Shell (`vcvarsall`) if MSVC is used.
- **Debug C/C++ File** (`c-cpp-pro.debugFile`): Builds the active file with debug symbols (`-g` or `/Zi`), scaffolds a launch configuration if missing, and immediately starts a debug session.

---

## 3. Launch Configuration Reference

To configure debugging, create or edit `.vscode/launch.json`. Set the `type` attribute to `"c-cpp-pro-debug"`.

### Example `launch.json`
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "C/C++ Pro: Launch Active File",
      "type": "c-cpp-pro-debug",
      "request": "launch",
      "program": "${workspaceFolder}/build/${fileBasenameNoExtension}",
      "args": [],
      "cwd": "${workspaceFolder}",
      "stopAtEntry": false,
      "debuggerType": "auto"
    }
  ]
}
```

### Configuration Attributes

| Attribute | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `program` | `string` | *(Required)* | Full path to the compiled executable binary. Supports variables like `${workspaceFolder}` and `${fileBasenameNoExtension}`. |
| `args` | `array` | `[]` | Command-line arguments passed to the target process. |
| `cwd` | `string` | `${workspaceFolder}` | Working directory for the launched process. |
| `stopAtEntry` | `boolean` | `false` | Automatically break at program entry point (`main`). |
| `environment` | `array` | `[]` | Array of `{ "name": "KEY", "value": "VAL" }` objects to inject into the process environment. |
| `debuggerType` | `string` | `"auto"` | Debug backend selection: `"auto"`, `"lldb-dap"`, or `"gdb"`. |
| `debuggerPath` | `string` | `""` | Explicit filesystem path to custom debugger executable. Auto-detected if omitted. |

---

## 4. Attaching to Running Processes

C/C++ Pro provides an interactive process picker to attach the debugger to any running process:

1. Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
2. Run **`C/C++ Pro: Pick Process to Attach`** (`c-cpp-pro.pickProcess`).
3. Search and select the target process by executable name or Process ID (PID).
4. C/C++ Pro attaches the debugger and breaks execution for inspection.

---

## 5. Evaluatable Expression Hover Provider

During active debug sessions, C/C++ Pro enriches cursor hovers using its AST Evaluatable Expression provider:
- **Member Access**: Automatically expands nested member expressions (`player->transform.position.x`).
- **Array Subscripts**: Selects full indexed lookups (`buffer[index]`).
- **Pointer Dereferences**: Evaluates dereferenced values (`*ptr`, `&variable`).

---

## 6. Debugger Troubleshooting

### `lldb-dap` Not Found
- Ensure LLVM is installed (`winget install LLVM.LLVM` on Windows, `brew install llvm` on macOS, or `apt install lldb` on Ubuntu/Debian).
- Set explicit path in settings:
  ```json
  {
    "c-cpp-pro.debuggerPath": "C:\\Program Files\\LLVM\\bin\\lldb-dap.exe"
  }
  ```

### GDB DAP Mode
- Requires GDB version 14.1 or newer for native DAP support (`gdb --interpreter=dap`).
