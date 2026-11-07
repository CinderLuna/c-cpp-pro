import * as fs from 'fs';
import * as path from 'path';

export interface ExternalSdkInfo {
  name: 'Vulkan' | 'raylib' | 'CUDA' | 'Boost' | 'SDL' | 'Qt';
  version?: string;
  rootPath: string;
  includePaths: string[];
  libraryPaths?: string[];
  source: 'env' | 'filesystem';
}

export interface ExternalSdkDetectorOptions {
  env?: Record<string, string | undefined>;
  allowFsScan?: boolean;
  requireWorkspaceMatch?: boolean;
  workspaceRoot?: string;
  preferredCompiler?: 'mingw' | 'gcc' | 'msvc' | 'clang' | string;
  preferredToolchain?: string;
  preferredArch?: 'x64' | 'x86' | 'arm64' | string;
  targetPlatform?: 'desktop' | 'android' | 'wasm' | 'ios' | string;
  qtInstallDir?: string;
}

/**
 * Detects preferred C/C++ compiler toolchain ('mingw', 'msvc', or 'clang') from options,
 * environment variables, workspace build configuration files, or system PATH.
 */
export function detectCompilerPreference(
  options: ExternalSdkDetectorOptions = {}
): 'mingw' | 'msvc' | 'clang' | undefined {
  if (options.preferredCompiler) {
    const norm = options.preferredCompiler.toLowerCase();
    if (norm.includes('gcc') || norm.includes('mingw')) return 'mingw';
    if (norm.includes('msvc') || norm.includes('cl')) return 'msvc';
    if (norm.includes('clang') || norm.includes('llvm')) return 'clang';
  }

  const env = options.env ?? process.env;

  // 1. Check explicit Qt kit environment variables
  const envToolchain = (env.QT_TOOLCHAIN || env.QT_KIT || '').toLowerCase();
  if (envToolchain.includes('mingw') || envToolchain.includes('gcc')) return 'mingw';
  if (envToolchain.includes('msvc') || envToolchain.includes('cl')) return 'msvc';
  if (envToolchain.includes('clang') || envToolchain.includes('llvm')) return 'clang';

  // 2. Check MSYSTEM or MinGW-specific environment variables
  if (env.MSYSTEM || env.MINGW_PREFIX || env.MINGW_CHOST) return 'mingw';

  // 3. Check Visual Studio / MSVC developer environment variables
  if (env.VCINSTALLDIR || env.VSINSTALLDIR || env.VisualStudioVersion) return 'msvc';

  // 4. Check CC and CXX environment variables
  const cxx = (env.CXX || env.CC || '').toLowerCase();
  if (cxx.includes('g++') || cxx.includes('gcc') || cxx.includes('mingw')) return 'mingw';
  if (/(?:^|[\\/])cl(?:\.exe)?$/i.test(cxx)) return 'msvc';
  if (cxx.includes('clang')) return 'clang';

  // 5. Inspect workspace build files if workspaceRoot is available
  const wsRoot = options.workspaceRoot;
  if (wsRoot) {
    try {
      // CMakeCache.txt
      const cmakeCacheCandidates = [
        path.join(wsRoot, 'CMakeCache.txt'),
        path.join(wsRoot, 'build', 'CMakeCache.txt'),
        path.join(wsRoot, 'out', 'CMakeCache.txt'),
        path.join(wsRoot, 'build', 'Debug', 'CMakeCache.txt'),
        path.join(wsRoot, 'build', 'Release', 'CMakeCache.txt')
      ];
      for (const cacheFile of cmakeCacheCandidates) {
        if (fs.existsSync(cacheFile)) {
          const cacheContent = fs.readFileSync(cacheFile, 'utf8');
          if (
            /CMAKE_CXX_COMPILER:FILEPATH=.*(?:g\+\+|gcc|mingw)/i.test(cacheContent) ||
            /CMAKE_GENERATOR:INTERNAL=.*MinGW/i.test(cacheContent)
          ) {
            return 'mingw';
          }
          if (
            /CMAKE_CXX_COMPILER:FILEPATH=.*(?:cl(?:\.exe)?)/i.test(cacheContent) ||
            /CMAKE_GENERATOR:INTERNAL=.*Visual Studio/i.test(cacheContent)
          ) {
            return 'msvc';
          }
          if (/CMAKE_CXX_COMPILER:FILEPATH=.*clang/i.test(cacheContent)) {
            return 'clang';
          }
        }
      }

      // Visual Studio solutions
      const rootFiles = fs.readdirSync(wsRoot);
      if (rootFiles.some((f) => f.endsWith('.sln') || f.endsWith('.slnx') || f.endsWith('.vcxproj'))) {
        return 'msvc';
      }

      // Makefile on Windows without solution files strongly indicates MinGW/GCC
      if (process.platform === 'win32' && rootFiles.some((f) => /^makefile$/i.test(f) || /^gnumakefile$/i.test(f))) {
        return 'mingw';
      }

      // compile_commands.json
      const compDbCandidates = [
        path.join(wsRoot, 'compile_commands.json'),
        path.join(wsRoot, 'build', 'compile_commands.json')
      ];
      for (const compDb of compDbCandidates) {
        if (fs.existsSync(compDb)) {
          let fd: number | undefined;
          let firstChunk = '';
          try {
            fd = fs.openSync(compDb, 'r');
            const buf = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
            firstChunk = buf.toString('utf8', 0, bytesRead);
          } finally {
            if (fd !== undefined) {
              fs.closeSync(fd);
            }
          }
          if (
            firstChunk.includes('g++') ||
            firstChunk.includes('gcc') ||
            firstChunk.includes('--driver-mode=g++') ||
            firstChunk.includes('mingw')
          ) {
            return 'mingw';
          }
          if (firstChunk.includes('cl.exe') || firstChunk.includes('--driver-mode=cl')) {
            return 'msvc';
          }
          if (firstChunk.includes('clang')) {
            return 'clang';
          }
        }
      }
    } catch {
      // Ignore filesystem inspection errors
    }
  }

  // 6. Inspect system PATH for toolchains
  const pathEnv = (env.PATH || env.Path || '').toLowerCase();
  const hasMinGwOnPath = pathEnv.includes('mingw') || pathEnv.includes('msys64');
  const hasMsvcOnPath = /(?:vc[\\/]tools[\\/]msvc|microsoft visual studio)/.test(pathEnv);

  if (hasMinGwOnPath && !hasMsvcOnPath) return 'mingw';
  if (hasMsvcOnPath && !hasMinGwOnPath) return 'msvc';

  return undefined;
}

/**
 * Detects target operating platform ('desktop', 'android', 'wasm', or 'ios') from options,
 * environment variables, or workspace indicator files (AndroidManifest.xml, CMakeLists.txt, .pro).
 */
export function detectTargetPlatform(
  options: ExternalSdkDetectorOptions = {}
): 'desktop' | 'android' | 'wasm' | 'ios' | string {
  if (options.targetPlatform) {
    return options.targetPlatform.toLowerCase();
  }

  const env = options.env ?? process.env;

  // 1. Check explicit toolchain override
  const explicitTc = (options.preferredToolchain || env.QT_TOOLCHAIN || env.QT_KIT || '').toLowerCase();
  if (explicitTc.startsWith('android')) return 'android';
  if (explicitTc.startsWith('wasm')) return 'wasm';
  if (explicitTc.startsWith('ios')) return 'ios';

  // 2. Check Android environment variables
  if (env.ANDROID_ABI || env.ANDROID_PLATFORM || env.ANDROID_TARGET_ARCH) return 'android';

  // 3. Inspect workspaceRoot if available
  const wsRoot = options.workspaceRoot;
  if (wsRoot) {
    try {
      // Direct AndroidManifest.xml presence
      if (
        fs.existsSync(path.join(wsRoot, 'AndroidManifest.xml')) ||
        fs.existsSync(path.join(wsRoot, 'android', 'AndroidManifest.xml'))
      ) {
        return 'android';
      }

      // CMakeCache.txt check
      const cmakeCacheCandidates = [
        path.join(wsRoot, 'CMakeCache.txt'),
        path.join(wsRoot, 'build', 'CMakeCache.txt'),
        path.join(wsRoot, 'out', 'CMakeCache.txt')
      ];
      for (const cacheFile of cmakeCacheCandidates) {
        if (fs.existsSync(cacheFile)) {
          const content = fs.readFileSync(cacheFile, 'utf8');
          if (
            /CMAKE_SYSTEM_NAME:STRING=Android/i.test(content) ||
            /ANDROID_ABI:STRING=/i.test(content) ||
            /ANDROID_NDK:PATH=/i.test(content)
          ) {
            return 'android';
          }
          if (/CMAKE_SYSTEM_NAME:STRING=Emscripten/i.test(content)) {
            return 'wasm';
          }
          if (/CMAKE_SYSTEM_NAME:STRING=iOS/i.test(content)) {
            return 'ios';
          }
        }
      }

      // CMakeLists.txt check
      const cmakeLists = path.join(wsRoot, 'CMakeLists.txt');
      if (fs.existsSync(cmakeLists)) {
        const content = fs.readFileSync(cmakeLists, 'utf8');
        if (
          /set\s*\(\s*CMAKE_SYSTEM_NAME\s+Android\s*\)/i.test(content) ||
          /ANDROID_PACKAGE_SOURCE_DIR/i.test(content) ||
          /qt_android_/i.test(content)
        ) {
          return 'android';
        }
      }

      // .pro / .pri project files
      const rootFiles = fs.readdirSync(wsRoot);
      for (const file of rootFiles) {
        if (file.endsWith('.pro') || file.endsWith('.pri')) {
          const content = fs.readFileSync(path.join(wsRoot, file), 'utf8');
          if (
            /ANDROID_PACKAGE_SOURCE_DIR/i.test(content) ||
            /contains\s*\(\s*ANDROID_TARGET_ARCH/i.test(content) ||
            /android\s*\{/i.test(content)
          ) {
            return 'android';
          }
        }
      }
    } catch {
      // Ignore filesystem inspection errors
    }
  }

  return 'desktop';
}

/**
 * Computes a suitability score for a Qt toolchain kit directory name.
 * If the project targets Android (or another cross-target), matching toolchains receive top priority.
 * If developing a desktop project, cross-compilation toolchains (android, wasm, ios, qnx) receive a severe
 * penalty to ensure desktop kits (mingw, msvc, gcc, clang) are preferred.
 */
export function scoreQtToolchain(
  tcName: string,
  options: ExternalSdkDetectorOptions = {}
): number {
  const lower = tcName.toLowerCase();
  const env = options.env ?? process.env;

  // 1. Explicit toolchain match has the absolute highest priority
  const explicitTc = (options.preferredToolchain || env.QT_TOOLCHAIN || env.QT_KIT || '').toLowerCase();
  if (explicitTc && lower.includes(explicitTc)) {
    return 100_000;
  }

  // 2. Detect target platform (desktop vs android vs wasm vs ios)
  const targetPlatform = detectTargetPlatform(options);
  const isCrossTarget = /^(?:android|wasm|ios|qnx|integrity|winrt)/i.test(lower);

  if (targetPlatform === 'android') {
    if (!lower.startsWith('android')) {
      // When targeting Android, non-Android toolchains should not be selected
      return -100_000;
    }
    let androidScore = 50_000;

    // ABI matching
    const prefAbi = (env.ANDROID_ABI || options.preferredArch || '').toLowerCase();
    if (prefAbi) {
      const cleanAbi = prefAbi.replace(/[-_]/g, '');
      const cleanTc = lower.replace(/[-_]/g, '');
      if (cleanTc.includes(cleanAbi)) {
        androidScore += 20_000;
      }
    } else {
      // Default Android ABI preference: 64-bit ARM first, then 64-bit x86 emulator, then 32-bit
      if (lower.includes('arm64_v8a')) androidScore += 10_000;
      else if (lower.includes('x86_64')) androidScore += 8_000;
      else if (lower.includes('armv7')) androidScore += 5_000;
    }
    return androidScore;
  }

  if (targetPlatform === 'wasm') {
    if (!lower.startsWith('wasm')) return -100_000;
    return 50_000 + (lower.includes('multithread') ? 5_000 : 0);
  }

  if (targetPlatform === 'ios') {
    if (!lower.startsWith('ios')) return -100_000;
    return 50_000;
  }

  // Desktop platform: penalize cross-compilation toolchains heavily
  if (isCrossTarget) {
    return -100_000;
  }

  let score = 10_000; // Base score for host desktop toolchains

  // 3. Compiler preference matching
  const prefCompiler = detectCompilerPreference(options);
  if (prefCompiler === 'mingw') {
    if (lower.includes('mingw')) score += 40_000;
    else if (lower.includes('gcc')) score += 30_000;
    else if (lower.includes('clang') || lower.includes('llvm')) score += 10_000;
    else if (lower.includes('msvc')) score += 2_000;
  } else if (prefCompiler === 'msvc') {
    if (lower.includes('msvc')) score += 40_000;
    else if (lower.includes('clang') || lower.includes('llvm')) score += 10_000;
    else if (lower.includes('mingw')) score += 2_000;
  } else if (prefCompiler === 'clang') {
    if (lower.includes('clang') || lower.includes('llvm')) score += 40_000;
    else if (lower.includes('mingw')) score += 10_000;
    else if (lower.includes('msvc')) score += 10_000;
  } else {
    // Default desktop priority by operating system
    if (process.platform === 'win32') {
      if (lower.includes('mingw')) score += 20_000;
      if (lower.includes('msvc')) score += 20_000;
      if (lower.includes('clang') || lower.includes('llvm')) score += 15_000;
    } else if (process.platform === 'linux') {
      if (lower.includes('gcc')) score += 20_000;
      if (lower.includes('clang')) score += 15_000;
    } else if (process.platform === 'darwin') {
      if (lower.includes('macos') || lower.includes('clang')) score += 20_000;
    }
  }

  // 4. Architecture preference matching
  const prefArch = options.preferredArch?.toLowerCase() || process.arch;
  if (prefArch === 'x64') {
    if (lower.includes('64') || lower.includes('x86_64') || lower.includes('amd64')) {
      score += 5_000;
    }
    if ((lower.includes('32') || lower.includes('x86')) && !lower.includes('64')) {
      score -= 3_000;
    }
  } else if (prefArch === 'arm64') {
    if (lower.includes('arm64')) {
      score += 5_000;
    }
  } else if (prefArch === 'ia32' || prefArch === 'x86') {
    if (lower.includes('32') || lower.includes('x86')) {
      score += 5_000;
    }
  }

  // 5. Toolchain recency / version ties
  if (lower.includes('msvc2022')) score += 500;
  else if (lower.includes('msvc2019')) score += 400;
  else if (lower.includes('msvc2017')) score += 300;
  else if (lower.includes('msvc2015')) score += 200;

  if (lower.includes('mingw13')) score += 500;
  else if (lower.includes('mingw11')) score += 400;
  else if (lower.includes('mingw8')) score += 300;

  return score;
}

/**
 * Compares two semantic version strings or version folder names in descending order.
 * E.g., '1.3.296.0' > '1.3.268.0', 'v12.4' > 'v12.2', 'boost_1_86_0' > 'boost_1_83_0'
 */
export function compareSemverDesc(a: string, b: string): number {
  const parse = (s: string) =>
    s
      .replace(/^[^0-9]*/, '')
      .split(/[._-]/)
      .map((n) => parseInt(n, 10) || 0);

  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a, 'en');
}

export class ExternalSdkDetector {
  /**
   * Discovers Vulkan SDK via VULKAN_SDK environment variable or standard installation paths.
   */
  public static detectVulkan(options: ExternalSdkDetectorOptions = {}): ExternalSdkInfo | null {
    const env = options.env ?? process.env;
    const allowFsScan = options.allowFsScan ?? true;

    // 1. Check environment variable VULKAN_SDK
    const envPath = env.VULKAN_SDK;
    if (envPath) {
      try {
        if (fs.existsSync(envPath)) {
          const incCandidates = [
            path.join(envPath, 'Include'),
            path.join(envPath, 'include')
          ];
          for (const inc of incCandidates) {
            if (fs.existsSync(inc)) {
              return {
                name: 'Vulkan',
                rootPath: envPath,
                includePaths: [inc],
                libraryPaths: [
                  path.join(envPath, 'Lib'),
                  path.join(envPath, 'lib')
                ].filter((p) => {
                  try { return fs.existsSync(p); } catch { return false; }
                }),
                source: 'env'
              };
            }
          }
        }
      } catch {
        // Ignore fs permission errors
      }
    }

    if (!allowFsScan) return null;

    // 2. Scan standard Windows paths: C:\VulkanSDK\<version>
    const candidateBases = [
      'C:\\VulkanSDK',
      'D:\\VulkanSDK'
    ];

    for (const base of candidateBases) {
      try {
        if (fs.existsSync(base)) {
          const entries = fs.readdirSync(base, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort(compareSemverDesc);

          for (const dirName of entries) {
            const rootDir = path.join(base, dirName);
            const incDir = path.join(rootDir, 'Include');
            const incDirLower = path.join(rootDir, 'include');
            const targetInc = fs.existsSync(incDir) ? incDir : (fs.existsSync(incDirLower) ? incDirLower : null);

            if (targetInc) {
              return {
                name: 'Vulkan',
                version: dirName,
                rootPath: rootDir,
                includePaths: [targetInc],
                libraryPaths: [path.join(rootDir, 'Lib'), path.join(rootDir, 'lib')].filter((p) => {
                  try { return fs.existsSync(p); } catch { return false; }
                }),
                source: 'filesystem'
              };
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // 3. Scan POSIX / Linux / macOS paths
    const posixCandidates = [
      '/usr/include/vulkan',
      '/usr/local/include/vulkan',
      '/opt/homebrew/include/vulkan'
    ];

    for (const p of posixCandidates) {
      try {
        if (fs.existsSync(p)) {
          const parent = path.dirname(p);
          return {
            name: 'Vulkan',
            rootPath: parent,
            includePaths: [parent],
            source: 'filesystem'
          };
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  /**
   * Discovers raylib via RAYLIB_DIR / RAYLIB_PATH or common installation directories.
   */
  public static detectRaylib(options: ExternalSdkDetectorOptions = {}): ExternalSdkInfo | null {
    const env = options.env ?? process.env;
    const allowFsScan = options.allowFsScan ?? true;

    // 1. Environment variables
    const envCandidates = [env.RAYLIB_DIR, env.RAYLIB_PATH, env.RAYLIB_ROOT];
    for (const envPath of envCandidates) {
      if (envPath) {
        try {
          if (fs.existsSync(envPath)) {
            const incCandidates = [
              path.join(envPath, 'raylib', 'src'),
              path.join(envPath, 'src'),
              path.join(envPath, 'include'),
              envPath
            ];
            for (const inc of incCandidates) {
              if (fs.existsSync(path.join(inc, 'raylib.h'))) {
                return {
                  name: 'raylib',
                  rootPath: envPath,
                  includePaths: [inc],
                  source: 'env'
                };
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!allowFsScan) return null;

    // 2. Standard Windows installation paths: C:\raylib
    const winCandidates = [
      { root: 'C:\\raylib', inc: 'C:\\raylib\\raylib\\src' },
      { root: 'C:\\raylib', inc: 'C:\\raylib\\include' },
      { root: 'C:\\raylib\\raylib', inc: 'C:\\raylib\\raylib\\include' },
      { root: 'D:\\raylib', inc: 'D:\\raylib\\raylib\\src' },
      { root: 'D:\\raylib', inc: 'D:\\raylib\\include' }
    ];

    for (const cand of winCandidates) {
      try {
        if (fs.existsSync(path.join(cand.inc, 'raylib.h'))) {
          return {
            name: 'raylib',
            rootPath: cand.root,
            includePaths: [cand.inc],
            source: 'filesystem'
          };
        }
      } catch {
        // Ignore
      }
    }

    // 3. POSIX / Linux / Homebrew paths
    const posixCandidates = [
      '/usr/local/include',
      '/usr/include',
      '/opt/homebrew/include'
    ];

    for (const dir of posixCandidates) {
      try {
        if (fs.existsSync(path.join(dir, 'raylib.h'))) {
          return {
            name: 'raylib',
            rootPath: dir,
            includePaths: [dir],
            source: 'filesystem'
          };
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  /**
   * Discovers NVIDIA CUDA Toolkit via CUDA_PATH or standard Windows/Linux installation paths.
   */
  public static detectCuda(options: ExternalSdkDetectorOptions = {}): ExternalSdkInfo | null {
    const env = options.env ?? process.env;
    const allowFsScan = options.allowFsScan ?? true;

    // 1. Environment variables
    const envCandidates = [
      env.CUDA_PATH,
      env.CUDA_HOME,
      ...Object.keys(env)
        .filter((k) => k.startsWith('CUDA_PATH_V'))
        .map((k) => env[k])
    ];

    for (const envPath of envCandidates) {
      if (envPath) {
        try {
          const inc = path.join(envPath, 'include');
          if (fs.existsSync(inc)) {
            return {
              name: 'CUDA',
              rootPath: envPath,
              includePaths: [inc],
              libraryPaths: [path.join(envPath, 'lib', 'x64')].filter((p) => {
                try { return fs.existsSync(p); } catch { return false; }
              }),
              source: 'env'
            };
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!allowFsScan) return null;

    // 2. Windows default path: C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v*.*
    const winBase = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA';
    try {
      if (fs.existsSync(winBase)) {
        const entries = fs.readdirSync(winBase, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort(compareSemverDesc);

        for (const dirName of entries) {
          const rootDir = path.join(winBase, dirName);
          const inc = path.join(rootDir, 'include');
          if (fs.existsSync(inc)) {
            return {
              name: 'CUDA',
              version: dirName,
              rootPath: rootDir,
              includePaths: [inc],
              libraryPaths: [path.join(rootDir, 'lib', 'x64')].filter((p) => {
                try { return fs.existsSync(p); } catch { return false; }
              }),
              source: 'filesystem'
            };
          }
        }
      }
    } catch {
      // Ignore
    }

    // 3. Linux default path: /usr/local/cuda/include
    const linuxInc = '/usr/local/cuda/include';
    try {
      if (fs.existsSync(linuxInc)) {
        return {
          name: 'CUDA',
          rootPath: '/usr/local/cuda',
          includePaths: [linuxInc],
          source: 'filesystem'
        };
      }
    } catch {
      // Ignore
    }

    return null;
  }

  /**
   * Discovers Boost C++ Libraries via BOOST_ROOT, BOOST_DIR, or C:\local\boost_*
   */
  public static detectBoost(options: ExternalSdkDetectorOptions = {}): ExternalSdkInfo | null {
    const env = options.env ?? process.env;
    const allowFsScan = options.allowFsScan ?? true;

    // 1. Environment variables
    const envCandidates = [env.BOOST_ROOT, env.BOOST_DIR, env.BOOST_INCLUDEDIR];
    for (const envPath of envCandidates) {
      if (envPath) {
        try {
          if (fs.existsSync(path.join(envPath, 'boost', 'version.hpp'))) {
            return {
              name: 'Boost',
              rootPath: envPath,
              includePaths: [envPath],
              source: 'env'
            };
          }
          const inc = path.join(envPath, 'include');
          if (fs.existsSync(path.join(inc, 'boost', 'version.hpp')) || fs.existsSync(inc)) {
            return {
              name: 'Boost',
              rootPath: envPath,
              includePaths: [inc],
              source: 'env'
            };
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!allowFsScan) return null;

    // 2. Windows common directory: C:\local\boost_*
    const localDir = 'C:\\local';
    try {
      if (fs.existsSync(localDir)) {
        const entries = fs.readdirSync(localDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.toLowerCase().startsWith('boost'))
          .map((d) => d.name)
          .sort(compareSemverDesc);

        for (const dirName of entries) {
          const rootDir = path.join(localDir, dirName);
          if (fs.existsSync(path.join(rootDir, 'boost', 'version.hpp'))) {
            return {
              name: 'Boost',
              version: dirName,
              rootPath: rootDir,
              includePaths: [rootDir],
              source: 'filesystem'
            };
          }
        }
      }
    } catch {
      // Ignore
    }

    // 3. POSIX common directories
    const posixDirs = ['/usr/include/boost', '/usr/local/include/boost', '/opt/homebrew/include/boost'];
    for (const p of posixDirs) {
      try {
        if (fs.existsSync(p)) {
          const parent = path.dirname(p);
          return {
            name: 'Boost',
            rootPath: parent,
            includePaths: [parent],
            source: 'filesystem'
          };
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  /**
   * Discovers SDL2 / SDL3 libraries via SDL2_DIR, SDL3_DIR, or C:\SDL2\include, etc.
   */
  public static detectSdl(options: ExternalSdkDetectorOptions = {}): ExternalSdkInfo | null {
    const env = options.env ?? process.env;
    const allowFsScan = options.allowFsScan ?? true;

    // 1. Environment variables
    const envCandidates = [
      { name: 'SDL3_DIR', val: env.SDL3_DIR },
      { name: 'SDL2_DIR', val: env.SDL2_DIR },
      { name: 'SDL_DIR', val: env.SDL_DIR }
    ];

    for (const item of envCandidates) {
      if (item.val) {
        try {
          const incCandidates = [
            path.join(item.val, 'include'),
            path.join(item.val, 'include', 'SDL2'),
            path.join(item.val, 'include', 'SDL3'),
            item.val
          ];
          for (const inc of incCandidates) {
            if (
              fs.existsSync(path.join(inc, 'SDL.h')) ||
              fs.existsSync(path.join(inc, 'SDL3', 'SDL.h')) ||
              fs.existsSync(path.join(inc, 'SDL2', 'SDL.h'))
            ) {
              return {
                name: 'SDL',
                rootPath: item.val,
                includePaths: [inc],
                source: 'env'
              };
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!allowFsScan) return null;

    // 2. Windows filesystem paths
    const winCandidates = [
      'C:\\SDL3\\include',
      'C:\\SDL2\\include',
      'C:\\SDL\\include',
      'C:\\local\\SDL2\\include',
      'C:\\local\\SDL3\\include'
    ];

    for (const inc of winCandidates) {
      try {
        if (fs.existsSync(inc)) {
          return {
            name: 'SDL',
            rootPath: path.dirname(inc),
            includePaths: [inc],
            source: 'filesystem'
          };
        }
      } catch {
        // Ignore
      }
    }

    // 3. POSIX paths
    const posixCandidates = [
      '/usr/include/SDL2',
      '/usr/include/SDL3',
      '/usr/local/include/SDL2',
      '/usr/local/include/SDL3',
      '/opt/homebrew/include/SDL2',
      '/opt/homebrew/include/SDL3'
    ];

    for (const dir of posixCandidates) {
      try {
        if (fs.existsSync(dir)) {
          return {
            name: 'SDL',
            rootPath: path.dirname(dir),
            includePaths: [dir, path.dirname(dir)],
            source: 'filesystem'
          };
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  /**
   * Discovers Qt SDK installation via QTDIR, Qt6_DIR, Qt5_DIR, or standard installation paths.
   */
  public static detectQt(options: ExternalSdkDetectorOptions = {}): ExternalSdkInfo | null {
    const env = options.env ?? process.env;
    const allowFsScan = options.allowFsScan ?? true;

    const qtModules = [
      'QtCore',
      'QtGui',
      'QtWidgets',
      'QtTest',
      'QtNetwork',
      'QtSql',
      'QtSvg',
      'QtQml',
      'QtQuick',
      'QtConcurrent',
      'QtXml'
    ];

    const collectQtIncludes = (incDir: string): string[] => {
      const includePaths = [incDir];
      // Dynamically discover all installed Qt* submodule directories
      try {
        const entries = fs.readdirSync(incDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('Qt')) {
            const subDir = path.join(incDir, entry.name);
            if (!includePaths.includes(subDir)) {
              includePaths.push(subDir);
            }
          }
        }
      } catch {
        // Fallback to checking predefined qtModules
      }
      for (const sub of qtModules) {
        const subDir = path.join(incDir, sub);
        if (fs.existsSync(subDir) && !includePaths.includes(subDir)) {
          includePaths.push(subDir);
        }
      }
      return includePaths;
    };

    // 1. Environment variables: QTDIR, Qt6_DIR, Qt5_DIR, CMAKE_PREFIX_PATH
    const rawEnv = [
      env.QTDIR,
      env.Qt6_DIR,
      env.Qt5_DIR,
      ...(env.CMAKE_PREFIX_PATH ? env.CMAKE_PREFIX_PATH.split(path.delimiter) : [])
    ];
    const envCandidates = rawEnv.filter((p): p is string => Boolean(p && p.trim()));

    for (const envPath of envCandidates) {
      try {
        const checkPaths = [
          envPath,
          path.resolve(envPath, '..'),
          path.resolve(envPath, '../..'),
          path.resolve(envPath, '../../..')
        ];
        for (const candidate of checkPaths) {
          const incDir = path.join(candidate, 'include');
          if (fs.existsSync(incDir)) {
            const includePaths = collectQtIncludes(incDir);
            const hasQtIndicators =
              includePaths.length > 1 ||
              fs.existsSync(path.join(incDir, 'qglobal.h')) ||
              fs.existsSync(path.join(incDir, 'QtCore', 'qstring.h')) ||
              fs.existsSync(path.join(incDir, 'qtcore-config.h'));
            if (!hasQtIndicators) {
              continue;
            }
            const libDir = path.join(candidate, 'lib');
            return {
              name: 'Qt',
              rootPath: candidate,
              includePaths,
              libraryPaths: fs.existsSync(libDir) ? [libDir] : undefined,
              source: 'env'
            };
          }
        }
      } catch {
        // Ignore
      }
    }

    if (!allowFsScan) return null;

    // 2. Scan standard installation folders
    const customBase = options.qtInstallDir || env.QT_BASE_DIR;
    const baseCandidates = [
      ...(customBase ? [customBase] : []),
      'C:\\Qt',
      'D:\\Qt',
      'F:\\Apps\\Qt',
      '/usr/include/qt6',
      '/usr/include/x86_64-linux-gnu/qt6',
      '/usr/include/aarch64-linux-gnu/qt6',
      '/usr/include/qt5',
      '/usr/include/x86_64-linux-gnu/qt5',
      '/usr/include/aarch64-linux-gnu/qt5',
      '/opt/homebrew/opt/qt',
      '/usr/local/opt/qt'
    ];

    for (const base of baseCandidates) {
      try {
        if (!fs.existsSync(base)) continue;

        // If base is direct include directory
        if (base.includes('include')) {
          const includePaths = collectQtIncludes(base);
          return {
            name: 'Qt',
            rootPath: path.dirname(base),
            includePaths,
            source: 'filesystem'
          };
        }

        // Direct include/ under base (e.g. Homebrew flat installation)
        const directInc = path.join(base, 'include');
        if (fs.existsSync(directInc)) {
          const includePaths = collectQtIncludes(directInc);
          const libDir = path.join(base, 'lib');
          return {
            name: 'Qt',
            rootPath: base,
            includePaths,
            libraryPaths: fs.existsSync(libDir) ? [libDir] : undefined,
            source: 'filesystem'
          };
        }

        // Base is a Qt installation directory with version folders (e.g. C:\Qt\6.8.0, C:\Qt\6.5.3)
        const entries = fs.readdirSync(base, { withFileTypes: true });
        const versionDirs = entries
          .filter((e) => e.isDirectory() && /^\d+(\.\d+)+$/.test(e.name))
          .map((e) => e.name)
          .sort(compareSemverDesc);

        interface QtCandidate {
          version: string;
          toolchain: string;
          rootPath: string;
          includePaths: string[];
          libraryPaths?: string[];
          isDesktop: boolean;
          score: number;
        }

        const candidates: QtCandidate[] = [];

        for (const vDir of versionDirs) {
          const vPath = path.join(base, vDir);
          try {
            const toolchains = fs.readdirSync(vPath, { withFileTypes: true });
            for (const tc of toolchains) {
              if (!tc.isDirectory()) continue;
              const tcPath = path.join(vPath, tc.name);
              const incDir = path.join(tcPath, 'include');
              if (fs.existsSync(incDir)) {
                const includePaths = collectQtIncludes(incDir);
                const hasQtIndicators =
                  includePaths.length > 1 ||
                  fs.existsSync(path.join(incDir, 'qglobal.h')) ||
                  fs.existsSync(path.join(incDir, 'QtCore', 'qstring.h')) ||
                  fs.existsSync(path.join(incDir, 'qtcore-config.h'));
                if (!hasQtIndicators) continue;

                const isCross = /^(?:android|wasm|ios|qnx|integrity|winrt)/i.test(tc.name);
                const score = scoreQtToolchain(tc.name, options);
                const libDir = path.join(tcPath, 'lib');

                candidates.push({
                  version: vDir,
                  toolchain: tc.name,
                  rootPath: tcPath,
                  includePaths,
                  libraryPaths: fs.existsSync(libDir) ? [libDir] : undefined,
                  isDesktop: !isCross,
                  score
                });
              }
            }
          } catch {
            // Ignore folder read error
          }
        }

        if (candidates.length > 0) {
          const effectivePlatform = detectTargetPlatform(options);
          const isExplicit = Boolean(options.preferredToolchain || env.QT_TOOLCHAIN || env.QT_KIT);

          let validCandidates: QtCandidate[];
          if (isExplicit) {
            validCandidates = candidates;
          } else if (effectivePlatform === 'android') {
            const androidCandidates = candidates.filter((c) => c.toolchain.toLowerCase().startsWith('android'));
            validCandidates = androidCandidates.length > 0 ? androidCandidates : candidates;
          } else if (effectivePlatform === 'wasm') {
            const wasmCandidates = candidates.filter((c) => c.toolchain.toLowerCase().startsWith('wasm'));
            validCandidates = wasmCandidates.length > 0 ? wasmCandidates : candidates;
          } else if (effectivePlatform === 'ios') {
            const iosCandidates = candidates.filter((c) => c.toolchain.toLowerCase().startsWith('ios'));
            validCandidates = iosCandidates.length > 0 ? iosCandidates : candidates;
          } else {
            // Desktop: eliminate cross-compilation toolchains if desktop toolchains exist
            validCandidates = candidates.some((c) => c.isDesktop)
              ? candidates.filter((c) => c.isDesktop)
              : candidates;
          }

          validCandidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return compareSemverDesc(a.version, b.version);
          });

          const best = validCandidates[0];
          if (best) {
            return {
              name: 'Qt',
              version: best.version,
              rootPath: best.rootPath,
              includePaths: best.includePaths,
              libraryPaths: best.libraryPaths,
              source: 'filesystem'
            };
          }
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  /**
   * Detects all supported external SDKs and returns their metadata.
   */
  public static detectAll(options: ExternalSdkDetectorOptions = {}): ExternalSdkInfo[] {
    const detectors = [
      () => ExternalSdkDetector.detectVulkan(options),
      () => ExternalSdkDetector.detectRaylib(options),
      () => ExternalSdkDetector.detectCuda(options),
      () => ExternalSdkDetector.detectBoost(options),
      () => ExternalSdkDetector.detectSdl(options),
      () => ExternalSdkDetector.detectQt(options)
    ];

    const results: ExternalSdkInfo[] = [];
    for (const detector of detectors) {
      try {
        const info = detector();
        if (info) {
          results.push(info);
        }
      } catch {
        // Safe fail-through
      }
    }

    return results;
  }

  /**
   * Gathers all detected include directories, normalized with forward slashes and de-duplicated.
   */
  public static getAllIncludePaths(options: ExternalSdkDetectorOptions = {}): string[] {
    const sdks = ExternalSdkDetector.detectAll(options);
    const seen = new Set<string>();
    const includePaths: string[] = [];

    for (const sdk of sdks) {
      for (const inc of sdk.includePaths) {
        const normalized = inc.replace(/\\/g, '/');
        if (!seen.has(normalized)) {
          seen.add(normalized);
          includePaths.push(normalized);
        }
      }
    }

    return includePaths;
  }

  /**
   * Checks whether the workspace actually references or uses the specified external SDK.
   * Scans source files and build configurations non-recursively into ignored directories.
   */
  public static isSdkUsedInWorkspace(workspaceRoot: string, sdkName: string): boolean {
    if (!workspaceRoot) return false;
    try {
      if (!fs.existsSync(workspaceRoot)) return false;
    } catch {
      return false;
    }

    return ExternalSdkDetector.getUsedSdksInWorkspace(workspaceRoot, [sdkName]).has(sdkName);
  }

  /**
   * Scans workspace in a single unified pass to determine which SDKs are referenced.
   */
  public static getUsedSdksInWorkspace(
    workspaceRoot: string,
    candidateSdkNames?: string[]
  ): Set<string> {
    const usedSdks = new Set<string>();
    if (!fs.existsSync(workspaceRoot)) return usedSdks;

    const sdkPatterns: Record<string, RegExp[]> = {
      Vulkan: [
        /#\s*include\s*[<"]vulkan\//i,
        /#\s*include\s*[<"]vulkan\.h[>"]/i,
        /#\s*include\s*[<"]vk_/i,
        /find_package\s*\(\s*Vulkan/i,
        /Vulkan::Vulkan/i,
        /"vulkan"/i,
        /VULKAN_HPP/i
      ],
      raylib: [
        /#\s*include\s*[<"](?:raylib|raymath|rlgl)\.h[>"]/i,
        /find_package\s*\(\s*raylib/i,
        /"raylib"/i
      ],
      CUDA: [
        /#\s*include\s*[<"]cuda/i,
        /#\s*include\s*[<"]cuda_runtime\.h[>"]/i,
        /find_package\s*\(\s*(?:CUDA|CUDAToolkit)/i,
        /enable_language\s*\(\s*CUDA/i
      ],
      Boost: [
        /#\s*include\s*[<"]boost\//i,
        /find_package\s*\(\s*Boost/i,
        /"boost"/i
      ],
      SDL: [
        /#\s*include\s*[<"](?:SDL2\/|SDL3\/|SDL\.h)/i,
        /find_package\s*\(\s*SDL[23]?/i,
        /"sdl[23]?"/i
      ],
      Qt: [
        /#\s*include\s*[<"]Q[A-Z]/,
        /#\s*include\s*[<"]q[a-z0-9_]+\.h[>"]/i,
        /#\s*include\s*[<"]Qt[A-Za-z]+\//i,
        /\bQT\s*\+?=/i,
        /find_package\s*\(\s*Qt[56]?/i,
        /qt_add_executable/i,
        /qt_add_resources/i,
        /target_link_libraries\s*\(.*Qt[56]::/i
      ]
    };

    const targetSdkNames = candidateSdkNames
      ? new Set(candidateSdkNames)
      : new Set(Object.keys(sdkPatterns));

    if (targetSdkNames.size === 0) return usedSdks;

    const ignoredDirs = new Set([
      'node_modules',
      '.git',
      '.vscode',
      '.clangd',
      'dist',
      'build',
      'out',
      '.cache',
      'bin',
      'obj',
      'target',
      'playground'
    ]);

    const sourceExts = new Set([
      '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.inl', '.ipp', '.ixx', '.cu', '.cuh'
    ]);

    const buildFileNames = new Set([
      'cmakelists.txt',
      'makefile',
      'vcpkg.json',
      'conanfile.txt',
      'meson.build'
    ]);

    const queue = [workspaceRoot];
    const maxFiles = 250;
    let filesChecked = 0;

    while (queue.length > 0 && filesChecked < maxFiles && usedSdks.size < targetSdkNames.size) {
      const currentDir = queue.shift()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!ignoredDirs.has(entry.name.toLowerCase())) {
            queue.push(path.join(currentDir, entry.name));
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const lowerName = entry.name.toLowerCase();

          if (targetSdkNames.has('CUDA') && (ext === '.cu' || ext === '.cuh')) {
            usedSdks.add('CUDA');
          }

          if (
            sourceExts.has(ext) ||
            buildFileNames.has(lowerName) ||
            lowerName.endsWith('.vcxproj') ||
            ext === '.pro' ||
            ext === '.pri'
          ) {
            filesChecked++;
            try {
              const filePath = path.join(currentDir, entry.name);
              const stat = fs.statSync(filePath);
              const readSize = Math.min(stat.size, 32768);
              const buffer = Buffer.alloc(readSize);
              const fd = fs.openSync(filePath, 'r');
              let text = '';
              try {
                fs.readSync(fd, buffer, 0, readSize, 0);
                text = buffer.toString('utf8');
              } finally {
                fs.closeSync(fd);
              }

              for (const sdk of targetSdkNames) {
                if (!usedSdks.has(sdk)) {
                  const patterns = sdkPatterns[sdk];
                  if (patterns) {
                    for (const pattern of patterns) {
                      if (pattern.test(text)) {
                        usedSdks.add(sdk);
                        break;
                      }
                    }
                  }
                }
              }

              if (usedSdks.size >= targetSdkNames.size) {
                return usedSdks;
              }
            } catch {
              // Ignore read errors
            }
          }
        }
      }
    }

    return usedSdks;
  }

  /**
   * Discovers include paths for external SDKs that are actually referenced/used in the given workspace.
   */
  public static getWorkspaceIncludePaths(
    workspaceRoot: string,
    options: ExternalSdkDetectorOptions = {}
  ): string[] {
    const mergedOpts: ExternalSdkDetectorOptions = {
      workspaceRoot,
      ...options
    };
    const sdks = ExternalSdkDetector.detectAll(mergedOpts);
    const usedSdkNames = ExternalSdkDetector.getUsedSdksInWorkspace(
      workspaceRoot,
      sdks.map((s) => s.name)
    );
    const seen = new Set<string>();
    const includePaths: string[] = [];

    for (const sdk of sdks) {
      if (usedSdkNames.has(sdk.name)) {
        for (const inc of sdk.includePaths) {
          const normalized = inc.replace(/\\/g, '/');
          if (!seen.has(normalized)) {
            seen.add(normalized);
            includePaths.push(normalized);
          }
        }
      }
    }

    return includePaths;
  }

  /**
   * Synchronizes discovered external SDK include paths into the workspace .clangd YAML configuration.
   * Only synchronizes SDKs that are actually used in the workspace, avoiding polluting non-Vulkan/SDK projects.
   * If .clangd exists, appends flags non-destructively without overriding existing user configuration.
   * Automatically purges any obsolete cross-compilation Qt include paths (e.g. android_arm64_v8a) when
   * a desktop Qt kit (MinGW, MSVC) is active.
   */
  public static syncWorkspaceClangdConfig(
    workspaceRoot: string,
    options: ExternalSdkDetectorOptions = {}
  ): boolean {
    try {
      const mergedOpts: ExternalSdkDetectorOptions = {
        workspaceRoot,
        ...options
      };
      const includes = options.requireWorkspaceMatch === false
        ? ExternalSdkDetector.getAllIncludePaths(mergedOpts)
        : ExternalSdkDetector.getWorkspaceIncludePaths(workspaceRoot, mergedOpts);

      if (includes.length === 0) return false;

      const clangdPath = path.join(workspaceRoot, '.clangd');
      const addFlags = includes.map((inc) => `-I${inc.replace(/\\/g, '/')}`);

      if (!fs.existsSync(clangdPath)) {
        const content = [
          '# Generated by C/C++ Pro - External SDKs & IntelliSense Integration',
          'CompileFlags:',
          '  Add:',
          ...addFlags.map((f) => `    - "${f}"`),
          ''
        ].join('\n');
        fs.writeFileSync(clangdPath, content, 'utf8');
        return true;
      }

      let existing = fs.readFileSync(clangdPath, 'utf8');

      // If desktop Qt is detected, purge any obsolete cross-compilation Qt flags (e.g. android, wasm)
      const hasDesktopQt = addFlags.some((f) => /(?:mingw|msvc|clang|gcc)[a-z0-9_]*\/include/i.test(f));
      let hadObsoleteCrossQt = false;
      if (hasDesktopQt) {
        const cleaned = existing
          .split('\n')
          .filter((line) => {
            if (/-(?:I|isystem)["']?.*[/\\](?:android|wasm|ios|qnx|integrity)[a-z0-9_]*[/\\]include/i.test(line)) {
              hadObsoleteCrossQt = true;
              return false;
            }
            return true;
          })
          .join('\n');
        if (hadObsoleteCrossQt) {
          existing = cleaned;
        }
      }

      const missingFlags = addFlags.filter((f) => !existing.includes(f));
      if (missingFlags.length === 0) {
        if (hadObsoleteCrossQt) {
          fs.writeFileSync(clangdPath, existing, 'utf8');
          return true;
        }
        return false;
      }

      if (/CompileFlags:\s*\r?\n\s*Add:/i.test(existing)) {
        const replacement = missingFlags.map((f) => `    - "${f}"`).join('\n');
        const updated = existing.replace(
          /(CompileFlags:\s*\r?\n\s*Add:)/i,
          `$1\n${replacement}`
        );
        fs.writeFileSync(clangdPath, updated, 'utf8');
        return true;
      } else if (/^CompileFlags:/im.test(existing)) {
        const flagsBlock = `  Add:\n` + missingFlags.map((f) => `    - "${f}"`).join('\n');
        const updated = existing.replace(
          /(^CompileFlags:)/im,
          `$1\n${flagsBlock}`
        );
        fs.writeFileSync(clangdPath, updated, 'utf8');
        return true;
      } else {
        const toAppend = [
          '',
          '# External SDKs added by C/C++ Pro',
          'CompileFlags:',
          '  Add:',
          ...missingFlags.map((f) => `    - "${f}"`),
          ''
        ].join('\n');
        fs.writeFileSync(clangdPath, existing.trimEnd() + '\n' + toAppend, 'utf8');
        return true;
      }
    } catch {
      return false;
    }
  }
}
