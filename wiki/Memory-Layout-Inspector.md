# Memory Layout Inspector

C/C++ Pro includes an interactive struct and class memory layout inspector. It visualizes byte offsets, member field alignments, padding holes, and CPU cache line boundaries directly inside Visual Studio Code.

---

## 1. Why Inspect Memory Layout?

In performance-critical C and C++ software (game engines, embedded systems, high-frequency trading, and operating systems), memory layout directly affects cache locality and memory bandwidth:
- **Padding Holes**: Compilers insert alignment padding between struct members, creating wasted memory.
- **Cache Locality**: Accessing members that span across 64-byte CPU cache lines causes multiple memory fetches.
- **False Sharing**: Multi-threaded access to variables residing on the same cache line leads to CPU core invalidation stalls.

C/C++ Pro calculates layout metrics accurately in real-time according to your target ABI.

---

## 2. Using the Inspector

### Launching the Inspector
There are two ways to inspect a struct or class layout:
1. **From Cursor Position**: Place your editor cursor inside any `struct`, `class`, or `union` declaration and run **`C/C++ Pro: Inspect Type & Memory Layout (Struct Padding / Alignment)`** (`c-cpp-pro.inspectMemoryLayout`).
2. **From Definition Hover**: Hover over a struct or class name. The rich hover card includes a direct link: **`Inspect Memory Layout`**. Click it to open the layout panel.
3. **From Usage Sites**: Hovering over a struct type or variable in a non-definition file automatically resolves the underlying declaration symbol and parameterizes the inspection link.

---

## 3. Metrics & Visualizations

The Memory Layout panel renders an interactive visual breakdown:

| Metric | Description | Optimization Target |
| :--- | :--- | :--- |
| **Total Size** | Total size of the struct in bytes. | Minimize overall footprint to fit more instances in CPU cache. |
| **Alignment** | Struct alignment requirement (e.g. 4, 8, or 16 bytes). | Dictated by the largest scalar member. |
| **Padding (Wasted)** | Total bytes lost to internal alignment padding and tail padding. | Aim for 0 bytes or minimum possible wasted space. |
| **Field Offsets** | Byte offset (`0x00`, `0x08`, etc.) and size of every member field. | Inspect exact member placement in memory. |
| **Cache Line Boundaries** | Indicators marking each 64-byte CPU cache line boundary. | Ensure frequently accessed hot fields fit inside the first cache line (`0..63` bytes). |

---

## 4. Platform Data Models & Packed Structs

C/C++ Pro calculates layout rules tailored to standard ABIs:

### Data Models
- **LLP64** (Windows x64):
  - `int`: 4 bytes, `long`: 4 bytes, `long long`: 8 bytes, pointers: 8 bytes.
- **LP64** (Linux & macOS x64):
  - `int`: 4 bytes, `long`: 8 bytes, `long long`: 8 bytes, pointers: 8 bytes.
- **ILP32** (32-bit platforms, x86, ARM32):
  - `int`: 4 bytes, `long`: 4 bytes, pointers: 4 bytes.

### Packed Structs
The inspector accurately handles packed struct directives:
- MSVC: `#pragma pack(push, 1)` / `#pragma pack(pop)`
- GCC / Clang: `__attribute__((packed))`

When packed, alignment requirements are relaxed to 1 byte and padding holes are eliminated.

---

## 5. Struct Reordering Example

Consider an unoptimized struct with interleaved field sizes:

```cpp
struct Unoptimized {
    bool active;        // 1 byte  (+ 7 bytes padding)
    double value;       // 8 bytes (offset 8)
    int count;          // 4 bytes (+ 4 bytes padding)
}; // Total: 24 bytes (11 bytes wasted padding)
```

By reordering members from largest to smallest alignment requirements:

```cpp
struct Optimized {
    double value;       // 8 bytes (offset 0)
    int count;          // 4 bytes (offset 8)
    bool active;        // 1 byte  (offset 12)
                        // (+ 3 bytes tail padding)
}; // Total: 16 bytes (33% memory reduction)
```

C/C++ Pro immediately visualizes these padding differences, enabling rapid memory footprint optimization.
