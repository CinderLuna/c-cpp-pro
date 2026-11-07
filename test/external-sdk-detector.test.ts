import './vscode-mock';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  ExternalSdkDetector,
  compareSemverDesc,
  detectCompilerPreference,
  detectTargetPlatform,
  scoreQtToolchain
} from '../src/prober/external-sdk-detector';
import { FlagSynthesizer } from '../src/prober/flag-synthesizer';
import { VcpkgAdvisor } from '../src/ecosystem/vcpkg-advisor';

describe('External SDKs Auto-Discovery Subsystem', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-sdk-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('compareSemverDesc', () => {
    it('should sort semantic versions descending', () => {
      const versions = ['1.3.268.0', '1.3.296.0', '1.2.189.0', '1.3.290.0'];
      versions.sort(compareSemverDesc);
      assert.deepStrictEqual(versions, ['1.3.296.0', '1.3.290.0', '1.3.268.0', '1.2.189.0']);
    });

    it('should sort CUDA version tags descending', () => {
      const versions = ['v11.8', 'v12.4', 'v12.2', 'v10.2'];
      versions.sort(compareSemverDesc);
      assert.deepStrictEqual(versions, ['v12.4', 'v12.2', 'v11.8', 'v10.2']);
    });

    it('should sort Boost folder versions descending', () => {
      const versions = ['boost_1_83_0', 'boost_1_86_0', 'boost_1_78_0'];
      versions.sort(compareSemverDesc);
      assert.deepStrictEqual(versions, ['boost_1_86_0', 'boost_1_83_0', 'boost_1_78_0']);
    });
  });

  describe('Vulkan SDK Detection', () => {
    it('should detect Vulkan from VULKAN_SDK environment variable', () => {
      const vulkanDir = path.join(tempDir, 'VulkanSDK', '1.3.296.0');
      const incDir = path.join(vulkanDir, 'Include');
      fs.mkdirSync(incDir, { recursive: true });
      fs.writeFileSync(path.join(incDir, 'vulkan.h'), '// Vulkan Header');

      const result = ExternalSdkDetector.detectVulkan({
        env: { VULKAN_SDK: vulkanDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Vulkan');
      assert.strictEqual(result.rootPath, vulkanDir);
      assert.strictEqual(result.source, 'env');
      assert.strictEqual(result.includePaths[0], incDir);
    });

    it('should return null when VULKAN_SDK is missing and fs scan is disabled', () => {
      const result = ExternalSdkDetector.detectVulkan({
        env: {},
        allowFsScan: false
      });
      assert.strictEqual(result, null);
    });
  });

  describe('raylib Detection', () => {
    it('should detect raylib from RAYLIB_DIR environment variable with src layout', () => {
      const raylibDir = path.join(tempDir, 'raylib');
      const srcDir = path.join(raylibDir, 'raylib', 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'raylib.h'), '// Raylib Header');

      const result = ExternalSdkDetector.detectRaylib({
        env: { RAYLIB_DIR: raylibDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'raylib');
      assert.strictEqual(result.source, 'env');
      assert.strictEqual(result.includePaths[0], srcDir);
    });

    it('should detect raylib from RAYLIB_PATH with include layout', () => {
      const raylibDir = path.join(tempDir, 'raylib_pkg');
      const incDir = path.join(raylibDir, 'include');
      fs.mkdirSync(incDir, { recursive: true });
      fs.writeFileSync(path.join(incDir, 'raylib.h'), '// Raylib Header');

      const result = ExternalSdkDetector.detectRaylib({
        env: { RAYLIB_PATH: raylibDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'raylib');
      assert.strictEqual(result.includePaths[0], incDir);
    });
  });

  describe('CUDA Toolkit Detection', () => {
    it('should detect CUDA from CUDA_PATH environment variable', () => {
      const cudaDir = path.join(tempDir, 'CUDA', 'v12.4');
      const incDir = path.join(cudaDir, 'include');
      fs.mkdirSync(incDir, { recursive: true });

      const result = ExternalSdkDetector.detectCuda({
        env: { CUDA_PATH: cudaDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'CUDA');
      assert.strictEqual(result.includePaths[0], incDir);
      assert.strictEqual(result.source, 'env');
    });
  });

  describe('Boost Detection', () => {
    it('should detect Boost from BOOST_ROOT environment variable', () => {
      const boostDir = path.join(tempDir, 'boost_1_86_0');
      const boostHdrDir = path.join(boostDir, 'boost');
      fs.mkdirSync(boostHdrDir, { recursive: true });
      fs.writeFileSync(path.join(boostHdrDir, 'version.hpp'), '#define BOOST_VERSION 108600');

      const result = ExternalSdkDetector.detectBoost({
        env: { BOOST_ROOT: boostDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Boost');
      assert.strictEqual(result.includePaths[0], boostDir);
    });
  });

  describe('SDL Detection', () => {
    it('should detect SDL2 from SDL2_DIR environment variable', () => {
      const sdlDir = path.join(tempDir, 'SDL2');
      const incDir = path.join(sdlDir, 'include');
      fs.mkdirSync(incDir, { recursive: true });
      fs.writeFileSync(path.join(incDir, 'SDL.h'), '// SDL2 Header');

      const result = ExternalSdkDetector.detectSdl({
        env: { SDL2_DIR: sdlDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'SDL');
      assert.strictEqual(result.includePaths[0], incDir);
    });
  });

  describe('Qt Detection', () => {
    it('should detect Qt from QTDIR environment variable', () => {
      const qtDir = path.join(tempDir, 'Qt6');
      const incDir = path.join(qtDir, 'include');
      const coreDir = path.join(incDir, 'QtCore');
      fs.mkdirSync(coreDir, { recursive: true });
      fs.writeFileSync(path.join(coreDir, 'qstring.h'), '// Qt QString Header');

      const result = ExternalSdkDetector.detectQt({
        env: { QTDIR: qtDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Qt');
      assert.ok(result.includePaths.includes(incDir));
      assert.ok(result.includePaths.includes(coreDir));
    });

    it('should detect Qt from Qt6_DIR pointing to lib/cmake/Qt6', () => {
      const qtPrefix = path.join(tempDir, 'Qt6Cmake');
      const cmakeDir = path.join(qtPrefix, 'lib', 'cmake', 'Qt6');
      const incDir = path.join(qtPrefix, 'include');
      const guiDir = path.join(incDir, 'QtGui');
      fs.mkdirSync(cmakeDir, { recursive: true });
      fs.mkdirSync(guiDir, { recursive: true });
      fs.writeFileSync(path.join(guiDir, 'qwindow.h'), '// Qt QWindow Header');

      const result = ExternalSdkDetector.detectQt({
        env: { Qt6_DIR: cmakeDir },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Qt');
      assert.ok(result.includePaths.includes(incDir));
      assert.ok(result.includePaths.includes(guiDir));
    });

    it('should detect Qt from delimited CMAKE_PREFIX_PATH when non-Qt prefix precedes it', () => {
      const otherPrefix = path.join(tempDir, 'OtherPrefix');
      const otherInc = path.join(otherPrefix, 'include');
      const qtPrefix = path.join(tempDir, 'QtPrefix');
      const incDir = path.join(qtPrefix, 'include');
      const coreDir = path.join(incDir, 'QtCore');
      fs.mkdirSync(otherInc, { recursive: true });
      fs.writeFileSync(path.join(otherInc, 'some_library.h'), '// Other lib');
      fs.mkdirSync(coreDir, { recursive: true });
      fs.writeFileSync(path.join(coreDir, 'qobject.h'), '// Qt QObject Header');

      const prefixPath = [otherPrefix, qtPrefix].join(path.delimiter);
      const result = ExternalSdkDetector.detectQt({
        env: { CMAKE_PREFIX_PATH: prefixPath },
        allowFsScan: false
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Qt');
      assert.strictEqual(result.rootPath, qtPrefix);
      assert.ok(result.includePaths.includes(incDir));
    });

    it('should score desktop toolchains higher than cross-compilation android toolchains', () => {
      const androidScore = scoreQtToolchain('android_arm64_v8a', { targetPlatform: 'desktop' });
      const mingwScore = scoreQtToolchain('mingw_64', { targetPlatform: 'desktop' });
      const msvcScore = scoreQtToolchain('msvc2022_64', { targetPlatform: 'desktop' });

      assert.ok(androidScore < -50000, `Expected severe penalty for android, got ${androidScore}`);
      assert.ok(mingwScore > 0, `Expected positive score for mingw, got ${mingwScore}`);
      assert.ok(msvcScore > 0, `Expected positive score for msvc, got ${msvcScore}`);
      assert.ok(mingwScore > androidScore);
      assert.ok(msvcScore > androidScore);
    });

    it('should prioritize mingw when preferredCompiler is mingw', () => {
      const mingwScore = scoreQtToolchain('mingw_64', { preferredCompiler: 'mingw' });
      const msvcScore = scoreQtToolchain('msvc2022_64', { preferredCompiler: 'mingw' });

      assert.ok(mingwScore > msvcScore, `Expected mingw (${mingwScore}) > msvc (${msvcScore})`);
    });

    it('should prioritize msvc when preferredCompiler is msvc', () => {
      const mingwScore = scoreQtToolchain('mingw_64', { preferredCompiler: 'msvc' });
      const msvcScore = scoreQtToolchain('msvc2022_64', { preferredCompiler: 'msvc' });

      assert.ok(msvcScore > mingwScore, `Expected msvc (${msvcScore}) > mingw (${mingwScore})`);
    });

    it('should prioritize mingw_64 over android_arm64_v8a in filesystem scan', () => {
      const qtBase = path.join(tempDir, 'QtRoot');
      const verDir = path.join(qtBase, '6.8.0');

      // Create android_arm64_v8a
      const androidInc = path.join(verDir, 'android_arm64_v8a', 'include', 'QtCore');
      fs.mkdirSync(androidInc, { recursive: true });
      fs.writeFileSync(path.join(androidInc, 'qstring.h'), '// android qstring');

      // Create mingw_64
      const mingwInc = path.join(verDir, 'mingw_64', 'include', 'QtCore');
      fs.mkdirSync(mingwInc, { recursive: true });
      fs.writeFileSync(path.join(mingwInc, 'qstring.h'), '// mingw qstring');

      const result = ExternalSdkDetector.detectQt({
        qtInstallDir: qtBase,
        allowFsScan: true
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Qt');
      assert.strictEqual(result.version, '6.8.0');
      assert.ok(
        result.rootPath.includes('mingw_64'),
        `Expected mingw_64 rootPath, got: ${result.rootPath}`
      );
      assert.ok(
        !result.rootPath.includes('android_arm64_v8a'),
        `Should not have selected android_arm64_v8a: ${result.rootPath}`
      );
    });

    it('should select older desktop Qt version over newer cross-compilation android Qt version', () => {
      const qtBase = path.join(tempDir, 'QtMultiVersion');

      // 6.8.0 only has android_arm64_v8a
      const androidInc = path.join(qtBase, '6.8.0', 'android_arm64_v8a', 'include', 'QtCore');
      fs.mkdirSync(androidInc, { recursive: true });
      fs.writeFileSync(path.join(androidInc, 'qstring.h'), '// android qstring');

      // 6.7.2 has desktop mingw_64
      const mingwInc = path.join(qtBase, '6.7.2', 'mingw_64', 'include', 'QtCore');
      fs.mkdirSync(mingwInc, { recursive: true });
      fs.writeFileSync(path.join(mingwInc, 'qstring.h'), '// mingw qstring');

      const result = ExternalSdkDetector.detectQt({
        qtInstallDir: qtBase,
        allowFsScan: true
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Qt');
      assert.strictEqual(result.version, '6.7.2');
      assert.ok(
        result.rootPath.includes('mingw_64'),
        `Expected 6.7.2/mingw_64, got: ${result.rootPath}`
      );
    });

    it('should detect compiler preference from CMakeCache.txt referencing MinGW', () => {
      const wsDir = path.join(tempDir, 'QtMinGwWs');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsDir, 'CMakeCache.txt'),
        'CMAKE_GENERATOR:INTERNAL=MinGW Makefiles\nCMAKE_CXX_COMPILER:FILEPATH=C:/msys64/mingw64/bin/g++.exe\n'
      );

      const pref = detectCompilerPreference({ workspaceRoot: wsDir });
      assert.strictEqual(pref, 'mingw');
    });

    it('should purge obsolete android_arm64_v8a flags when synchronizing .clangd with desktop Qt', () => {
      const wsDir = path.join(tempDir, 'WsCleanClangd');
      const qtBase = path.join(tempDir, 'QtPurge');
      const verDir = path.join(qtBase, '6.8.0');

      const mingwInc = path.join(verDir, 'mingw_64', 'include', 'QtCore');
      fs.mkdirSync(mingwInc, { recursive: true });
      fs.writeFileSync(path.join(mingwInc, 'qstring.h'), '// mingw');

      fs.mkdirSync(wsDir, { recursive: true });
      // Create project file referencing Qt
      fs.writeFileSync(path.join(wsDir, 'main.cpp'), '#include <QApplication>\n#include <QWidget>\n');

      // Create .clangd that contains old obsolete android_arm64_v8a flags
      const clangdFile = path.join(wsDir, '.clangd');
      fs.writeFileSync(
        clangdFile,
        [
          'CompileFlags:',
          '  Add:',
          '    - "-std=c++20"',
          '    - "-IC:/Qt/6.8.0/android_arm64_v8a/include"',
          '    - "-IC:/Qt/6.8.0/android_arm64_v8a/include/QtCore"'
        ].join('\n')
      );

      const synced = ExternalSdkDetector.syncWorkspaceClangdConfig(wsDir, {
        qtInstallDir: qtBase,
        allowFsScan: true
      });

      assert.ok(synced);
      const updatedClangd = fs.readFileSync(clangdFile, 'utf8');
      assert.ok(
        !updatedClangd.includes('android_arm64_v8a'),
        'Obsolete android_arm64_v8a flag was not purged from .clangd'
      );
      assert.ok(
        updatedClangd.includes('mingw_64'),
        'Desktop mingw_64 flag was not added to .clangd'
      );
    });

    it('should automatically detect Android targetPlatform when AndroidManifest.xml exists', () => {
      const wsDir = path.join(tempDir, 'QtAndroidWs');
      fs.mkdirSync(path.join(wsDir, 'android'), { recursive: true });
      fs.writeFileSync(
        path.join(wsDir, 'android', 'AndroidManifest.xml'),
        '<manifest package="org.qtproject.example"></manifest>'
      );

      const platform = detectTargetPlatform({ workspaceRoot: wsDir });
      assert.strictEqual(platform, 'android');
    });

    it('should automatically detect Android targetPlatform from CMakeLists.txt setting CMAKE_SYSTEM_NAME Android', () => {
      const wsDir = path.join(tempDir, 'QtAndroidCMakeWs');
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(
        path.join(wsDir, 'CMakeLists.txt'),
        'cmake_minimum_required(VERSION 3.22)\nset(CMAKE_SYSTEM_NAME Android)\nfind_package(Qt6 REQUIRED COMPONENTS Core)\n'
      );

      const platform = detectTargetPlatform({ workspaceRoot: wsDir });
      assert.strictEqual(platform, 'android');
    });

    it('should select android_arm64_v8a when developing an Android Qt project', () => {
      const wsDir = path.join(tempDir, 'QtAndroidAppProject');
      const qtBase = path.join(tempDir, 'QtAndroidInstall');
      const verDir = path.join(qtBase, '6.8.0');

      // Both desktop and android are installed
      const mingwInc = path.join(verDir, 'mingw_64', 'include', 'QtCore');
      fs.mkdirSync(mingwInc, { recursive: true });
      fs.writeFileSync(path.join(mingwInc, 'qstring.h'), '// mingw');

      const androidInc = path.join(verDir, 'android_arm64_v8a', 'include', 'QtCore');
      fs.mkdirSync(androidInc, { recursive: true });
      fs.writeFileSync(path.join(androidInc, 'qstring.h'), '// android');

      // Project has AndroidManifest.xml
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, 'AndroidManifest.xml'), '<manifest></manifest>');

      const result = ExternalSdkDetector.detectQt({
        workspaceRoot: wsDir,
        qtInstallDir: qtBase,
        allowFsScan: true
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Qt');
      assert.ok(
        result.rootPath.includes('android_arm64_v8a'),
        `Expected android_arm64_v8a for Android project, got: ${result.rootPath}`
      );
    });

    it('should respect explicit preferredToolchain=android_arm64_v8a override even on desktop', () => {
      const qtBase = path.join(tempDir, 'QtExplicitAndroid');
      const verDir = path.join(qtBase, '6.8.0');

      const mingwInc = path.join(verDir, 'mingw_64', 'include', 'QtCore');
      fs.mkdirSync(mingwInc, { recursive: true });
      fs.writeFileSync(path.join(mingwInc, 'qstring.h'), '// mingw');

      const androidInc = path.join(verDir, 'android_arm64_v8a', 'include', 'QtCore');
      fs.mkdirSync(androidInc, { recursive: true });
      fs.writeFileSync(path.join(androidInc, 'qstring.h'), '// android');

      const result = ExternalSdkDetector.detectQt({
        preferredToolchain: 'android_arm64_v8a',
        qtInstallDir: qtBase,
        allowFsScan: true
      });

      assert.ok(result);
      assert.strictEqual(result.name, 'Qt');
      assert.ok(
        result.rootPath.includes('android_arm64_v8a'),
        `Expected explicit android_arm64_v8a to win, got: ${result.rootPath}`
      );
    });
  });

  describe('getAllIncludePaths & Normalization', () => {
    it('should aggregate, de-duplicate, and normalize all detected SDK includes', () => {
      const vulkanDir = path.join(tempDir, 'VulkanSDK');
      const vulkanInc = path.join(vulkanDir, 'Include');
      fs.mkdirSync(vulkanInc, { recursive: true });

      const raylibDir = path.join(tempDir, 'raylib');
      const raylibInc = path.join(raylibDir, 'include');
      fs.mkdirSync(raylibInc, { recursive: true });
      fs.writeFileSync(path.join(raylibInc, 'raylib.h'), '// raylib');

      const includes = ExternalSdkDetector.getAllIncludePaths({
        env: {
          VULKAN_SDK: vulkanDir,
          RAYLIB_DIR: raylibDir
        },
        allowFsScan: false
      });

      assert.ok(includes.length >= 2);
      // All paths should use forward slashes
      for (const inc of includes) {
        assert.ok(!inc.includes('\\'), `Expected forward slashes in path: ${inc}`);
      }
      assert.ok(includes.includes(vulkanInc.replace(/\\/g, '/')));
      assert.ok(includes.includes(raylibInc.replace(/\\/g, '/')));
    });
  });

  describe('VcpkgAdvisor External Headers Catalog', () => {
    it('should match Vulkan, raylib, SDL, and CUDA headers', () => {
      const vulkan = VcpkgAdvisor.matchHeader('#include <vulkan/vulkan.h>');
      assert.ok(vulkan);
      assert.strictEqual(vulkan.info.port, 'vulkan');

      const raylib = VcpkgAdvisor.matchHeader('#include "raylib.h"');
      assert.ok(raylib);
      assert.strictEqual(raylib.info.port, 'raylib');

      const sdl2 = VcpkgAdvisor.matchHeader('#include <SDL2/SDL.h>');
      assert.ok(sdl2);
      assert.strictEqual(sdl2.info.port, 'sdl2');

      const cuda = VcpkgAdvisor.matchHeader('#include <cuda_runtime.h>');
      assert.ok(cuda);
      assert.strictEqual(cuda.info.port, 'cuda');
    });
  });

  describe('FlagSynthesizer with External SDKs', () => {
    it('should append detected external SDK include flags', async () => {
      const synthesizer = new FlagSynthesizer(
        { detectCompilers: async () => [] } as any,
        { extractSystemIncludes: async () => ['C:\\MSVC\\include'] } as any
      );

      const compiler = {
        name: 'MSVC',
        type: 'msvc' as const,
        path: 'C:\\MSVC\\bin\\cl.exe',
        version: '19.38',
        target: 'x86_64-pc-windows-msvc',
        isDefault: true
      };

      const flags = await synthesizer.generateFlags(compiler, {
        standard: 'c++20',
        detectExternalSdks: false // should exclude when false
      });

      assert.ok(flags.includes('--driver-mode=cl'));
      assert.ok(flags.includes('-IC:/MSVC/include'));
    });
  });

  describe('syncWorkspaceClangdConfig', () => {
    it('should NOT create .clangd file in a non-Vulkan project', () => {
      const vulkanDir = path.join(tempDir, 'VulkanSDK');
      const vulkanInc = path.join(vulkanDir, 'Include');
      fs.mkdirSync(vulkanInc, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'main.cpp'), '#include <iostream>\nint main() { return 0; }\n');

      const synced = ExternalSdkDetector.syncWorkspaceClangdConfig(tempDir, {
        env: { VULKAN_SDK: vulkanDir },
        allowFsScan: false
      });

      assert.strictEqual(synced, false, 'Must not sync or generate .clangd for non-Vulkan project');
      const clangdFile = path.join(tempDir, '.clangd');
      assert.strictEqual(fs.existsSync(clangdFile), false, '.clangd must not be created');
    });

    it('should create .clangd file with CompileFlags.Add if project references Vulkan', () => {
      const vulkanDir = path.join(tempDir, 'VulkanSDK');
      const vulkanInc = path.join(vulkanDir, 'Include');
      fs.mkdirSync(vulkanInc, { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'app.cpp'), '#include <vulkan/vulkan.h>\n');

      const synced = ExternalSdkDetector.syncWorkspaceClangdConfig(tempDir, {
        env: { VULKAN_SDK: vulkanDir },
        allowFsScan: false
      });

      assert.strictEqual(synced, true);
      const clangdFile = path.join(tempDir, '.clangd');
      assert.ok(fs.existsSync(clangdFile));
      const content = fs.readFileSync(clangdFile, 'utf8');
      assert.ok(content.includes('CompileFlags:'));
      assert.ok(content.includes('Add:'));
      assert.ok(content.includes(vulkanInc.replace(/\\/g, '/')));
    });

    it('should update existing .clangd non-destructively and preserve custom sections', () => {
      const clangdFile = path.join(tempDir, '.clangd');
      fs.writeFileSync(
        clangdFile,
        'Diagnostics:\n  UnusedIncludes: Strict\nCompileFlags:\n  Add:\n    - "-std=c++20"\n',
        'utf8'
      );

      const raylibDir = path.join(tempDir, 'raylib');
      const raylibInc = path.join(raylibDir, 'include');
      fs.mkdirSync(raylibInc, { recursive: true });
      fs.writeFileSync(path.join(raylibInc, 'raylib.h'), '// raylib');
      fs.writeFileSync(path.join(tempDir, 'game.cpp'), '#include "raylib.h"\n');

      const synced = ExternalSdkDetector.syncWorkspaceClangdConfig(tempDir, {
        env: { RAYLIB_DIR: raylibDir },
        allowFsScan: false
      });

      assert.strictEqual(synced, true);
      const updated = fs.readFileSync(clangdFile, 'utf8');
      assert.ok(updated.includes('UnusedIncludes: Strict'), 'Must preserve existing Diagnostics section');
      assert.ok(updated.includes('"-std=c++20"'), 'Must preserve existing flags');
      assert.ok(updated.includes(raylibInc.replace(/\\/g, '/')), 'Must append raylib include flag');
    });
  });
});
