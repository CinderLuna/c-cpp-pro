import './vscode-mock';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { mockVscode } from './vscode-mock';
import { CMakeFileApiReader } from '../src/cmake/cmake-file-api';
import { CMakePresetsParser } from '../src/cmake/cmake-presets';
import { CMakeTargetLauncher } from '../src/cmake/cmake-target-launcher';
import { CTestRunner } from '../src/testing/ctest-runner';
import { StreamingProblemMatcher } from '../src/diagnostics/problem-matcher';
import { CMakeListsModifier } from '../src/cmake/cmake-modifier';
import { CMakeManager } from '../src/cmake/cmake-manager';
import { CMakeLanguageService } from '../src/cmake/cmake-language-service';
import { ProjectBuildController } from '../src/tasks/project-build-controller';
import { CompilerDetector } from '../src/prober/compiler-detector';
import { SystemIncludeExtractor } from '../src/prober/system-includes';

describe('CMake Modernization Subsystems (Issue #5)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-cmake-mod-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    mockVscode.workspace.workspaceFolders = [];
  });

  describe('CMakeFileApiReader', () => {
    it('should find reply directory and parse codemodel-v2 artifacts', () => {
      const replyDir = path.join(tempDir, 'build', '.cmake', 'api', 'v1', 'reply');
      fs.mkdirSync(replyDir, { recursive: true });

      const indexJson = {
        reply: {
          'codemodel-v2': { jsonFile: 'codemodel-v2-test.json' },
          'cache-v2': { jsonFile: 'cache-v2-test.json' },
          'toolchains-v1': { jsonFile: 'toolchains-v1-test.json' }
        }
      };
      fs.writeFileSync(path.join(replyDir, 'index-2026-01-01T00-00-00.json'), JSON.stringify(indexJson));

      const codeModelJson = {
        configurations: [
          {
            name: 'Debug',
            targets: [
              { name: 'MyExecutable', jsonFile: 'target-MyExecutable.json' },
              { name: 'MyLibrary', jsonFile: 'target-MyLibrary.json' }
            ]
          }
        ]
      };
      fs.writeFileSync(path.join(replyDir, 'codemodel-v2-test.json'), JSON.stringify(codeModelJson));

      const execTargetJson = {
        name: 'MyExecutable',
        type: 'EXECUTABLE',
        artifacts: [{ path: 'bin/MyExecutable.exe' }],
        sources: [{ path: 'src/main.cpp', compileGroupIndex: 0 }],
        compileGroups: [
          {
            language: 'CXX',
            includes: [{ path: path.join(tempDir, 'include') }],
            preprocessorDefinitions: [{ define: 'DEBUG=1' }, { define: 'APP_VERSION="1.0"' }]
          }
        ]
      };
      fs.writeFileSync(path.join(replyDir, 'target-MyExecutable.json'), JSON.stringify(execTargetJson));

      const libTargetJson = {
        name: 'MyLibrary',
        type: 'STATIC_LIBRARY',
        artifacts: [{ path: 'lib/libMyLibrary.a' }],
        sources: [{ path: 'src/lib.cpp', compileGroupIndex: 0 }],
        compileGroups: [
          {
            language: 'CXX',
            includes: [{ path: path.join(tempDir, 'include') }],
            preprocessorDefinitions: [{ define: 'LIB_EXPORT=1' }]
          }
        ]
      };
      fs.writeFileSync(path.join(replyDir, 'target-MyLibrary.json'), JSON.stringify(libTargetJson));

      const cacheJson = {
        entries: [
          { name: 'CMAKE_BUILD_TYPE', type: 'STRING', value: 'Debug' },
          { name: 'BUILD_SHARED_LIBS', type: 'BOOL', value: 'OFF' }
        ]
      };
      fs.writeFileSync(path.join(replyDir, 'cache-v2-test.json'), JSON.stringify(cacheJson));

      const toolchainsJson = {
        toolchains: [
          {
            language: 'CXX',
            compiler: {
              path: 'C:/LLVM/bin/clang++.exe',
              id: 'Clang',
              version: '19.1.0',
              target: 'x86_64-pc-windows-msvc'
            }
          }
        ]
      };
      fs.writeFileSync(path.join(replyDir, 'toolchains-v1-test.json'), JSON.stringify(toolchainsJson));

      // 1. Locate reply directory
      const foundReplyDir = CMakeFileApiReader.findReplyDirectory(tempDir);
      assert.ok(foundReplyDir);
      assert.strictEqual(foundReplyDir.toLowerCase(), replyDir.replace(/\\/g, '/').toLowerCase());

      // 2. Parse reply
      const parsed = CMakeFileApiReader.parseReply(tempDir, foundReplyDir);
      assert.ok(parsed);
      assert.strictEqual(parsed.project.targets.length, 2);

      const execTarget = parsed.project.targets.find((t) => t.name === 'MyExecutable');
      assert.ok(execTarget);
      assert.strictEqual(execTarget.type, 'executable');
      assert.ok(execTarget.compileDefinitions.includes('DEBUG=1'));

      assert.strictEqual(parsed.executableTargets.length, 1);
      assert.strictEqual(parsed.executableTargets[0].name, 'MyExecutable');
      assert.ok(parsed.executableTargets[0].binaryPath.endsWith('bin/MyExecutable.exe'));

      assert.strictEqual(parsed.cacheEntries?.['CMAKE_BUILD_TYPE'], 'Debug');
      assert.strictEqual(parsed.toolchains?.['CXX'].id, 'Clang');
      assert.strictEqual(parsed.toolchains?.['CXX'].targetTriple, 'x86_64-pc-windows-msvc');
    });

    it('should return null when reply directory does not exist or lacks index file', () => {
      assert.strictEqual(CMakeFileApiReader.findReplyDirectory(tempDir), null);
      assert.strictEqual(CMakeFileApiReader.parseReply(tempDir, path.join(tempDir, 'nonexistent')), null);
    });
  });

  describe('CMakePresetsParser', () => {
    it('should perform macro substitution correctly', () => {
      const template = '${sourceDir}/build/${presetName}-${generator}-${hostSystemName}-${pathListSep}';
      const expanded = CMakePresetsParser.expandMacros(template, tempDir, 'x64-Debug', 'Ninja');

      assert.ok(expanded.startsWith(tempDir.replace(/\\/g, '/')));
      assert.ok(expanded.includes('x64-Debug'));
      assert.ok(expanded.includes('Ninja'));
      assert.ok(expanded.includes(process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : 'Darwin'));
      assert.ok(expanded.includes(path.delimiter));
    });

    it('should load CMakePresets.json and merge with CMakeUserPresets.json', () => {
      const mainPresets = {
        version: 3,
        configurePresets: [
          {
            name: 'default',
            displayName: 'Default Config',
            generator: 'Ninja',
            binaryDir: '${sourceDir}/build/default'
          },
          {
            name: 'release',
            displayName: 'Release Config',
            generator: 'Ninja',
            binaryDir: '${sourceDir}/build/release'
          }
        ],
        buildPresets: [
          {
            name: 'build-default',
            configurePreset: 'default'
          }
        ]
      };

      const userPresets = {
        version: 3,
        configurePresets: [
          {
            name: 'default',
            displayName: 'Default Config (User Override)',
            binaryDir: '${sourceDir}/out/custom-default'
          },
          {
            name: 'user-local',
            displayName: 'Local Dev Preset',
            binaryDir: '${sourceDir}/out/local'
          }
        ]
      };

      fs.writeFileSync(path.join(tempDir, 'CMakePresets.json'), JSON.stringify(mainPresets));
      fs.writeFileSync(path.join(tempDir, 'CMakeUserPresets.json'), JSON.stringify(userPresets));

      const loaded = CMakePresetsParser.loadPresets(tempDir);
      assert.ok(loaded);
      assert.strictEqual(loaded.configurePresets.length, 3);

      const defaultPreset = loaded.configurePresets.find((p) => p.name === 'default');
      assert.ok(defaultPreset);
      assert.strictEqual(defaultPreset.displayName, 'Default Config (User Override)');
      assert.ok(defaultPreset.binaryDir?.includes('/out/custom-default'));

      const dbPath = CMakePresetsParser.getCompilationDatabasePath(defaultPreset, tempDir);
      assert.ok(dbPath.endsWith('compile_commands.json'));
    });
  });

  describe('CMakeTargetLauncher', () => {
    it('should manage executable targets and select active launch target', () => {
      const launcher = new CMakeTargetLauncher();

      launcher.setExecutableTargets([
        { name: 'AppServer', binaryPath: path.join(tempDir, 'bin', 'AppServer.exe') },
        { name: 'AppClient', binaryPath: path.join(tempDir, 'bin', 'AppClient.exe') }
      ]);

      assert.strictEqual(launcher.getActiveTarget()?.name, 'AppServer');
      assert.strictEqual(launcher.getKnownTargets().length, 2);

      launcher.dispose();
    });
  });

  describe('CTestRunner', () => {
    it('should parse CTestTestfile.cmake correctly', () => {
      const buildDir = path.join(tempDir, 'build');
      fs.mkdirSync(buildDir, { recursive: true });

      const ctestContent = `
        # Generated by CMake
        subdirs("sub")
        add_test("UnitTestSuite" "${tempDir}/bin/unit_tests.exe" "--gtest_output=xml")
        add_test("IntegrationTestSuite" "${tempDir}/bin/integration_tests.exe" "-v")
      `;
      fs.writeFileSync(path.join(buildDir, 'CTestTestfile.cmake'), ctestContent);

      const tests = CTestRunner.parseCTestTestfile(buildDir);
      assert.strictEqual(tests.length, 2);
      assert.strictEqual(tests[0].name, 'UnitTestSuite');
      assert.ok(tests[0].command[0].endsWith('unit_tests.exe'));
      assert.strictEqual(tests[0].command[1], '--gtest_output=xml');

      assert.strictEqual(tests[1].name, 'IntegrationTestSuite');
    });

    it('should populate test items into VS Code test controller', () => {
      const controller = vscode.tests.createTestController('test-ctest', 'Test CTest');
      const tests = [
        { name: 'MathTest', command: ['math_test'] },
        { name: 'StringTest', command: ['string_test'] }
      ];

      const root = CTestRunner.populateTestController(controller, tests, tempDir);
      assert.ok(root);
      assert.strictEqual(root.children.size, 2);

      controller.dispose();
    });
  });

  describe('StreamingProblemMatcher', () => {
    it('should parse GCC/Clang error and warning messages', () => {
      const matcher = new StreamingProblemMatcher('test-gcc');

      const errLine = 'src/main.cpp:42:15: error: expected ";" before "return"';
      const parsedErr = matcher.parseLine(errLine, tempDir);
      assert.ok(parsedErr);
      assert.strictEqual(parsedErr.line, 41);
      assert.strictEqual(parsedErr.column, 14);
      assert.strictEqual(parsedErr.severity, vscode.DiagnosticSeverity.Error);
      assert.strictEqual(parsedErr.message, 'expected ";" before "return"');

      const warnLine = 'include/util.h:10:5: warning: unused variable "foo"';
      const parsedWarn = matcher.parseLine(warnLine, tempDir);
      assert.ok(parsedWarn);
      assert.strictEqual(parsedWarn.severity, vscode.DiagnosticSeverity.Warning);

      matcher.dispose();
    });

    it('should parse MSVC error and warning messages with error codes', () => {
      const matcher = new StreamingProblemMatcher('test-msvc');

      const msvcErr = 'F:\\DEV\\main.cpp(105,8): error C2065: "undeclared_var": undeclared identifier';
      const parsed = matcher.parseLine(msvcErr, tempDir);
      assert.ok(parsed);
      assert.strictEqual(parsed.line, 104);
      assert.strictEqual(parsed.column, 7);
      assert.strictEqual(parsed.severity, vscode.DiagnosticSeverity.Error);
      assert.strictEqual(parsed.code, 'C2065');
      assert.ok(parsed.message.includes('C2065: "undeclared_var": undeclared identifier'));

      matcher.dispose();
    });
  });

  describe('CMakeListsModifier', () => {
    it('should discover target declarations in CMakeLists.txt', () => {
      const cmakeLists = `
        cmake_minimum_required(VERSION 3.20)
        project(SampleApp)

        # add_executable(IgnoredCommentedOutApp src/ignored.cpp)
        add_executable(ServerApp src/server.cpp)
        add_library(SharedUtils SHARED src/utils.cpp)
        target_sources(ServerApp PRIVATE src/extra.cpp)
      `;

      const targets = CMakeListsModifier.findTargets(cmakeLists);
      assert.strictEqual(targets.length, 3);
      assert.strictEqual(targets[0].name, 'ServerApp');
      assert.strictEqual(targets[0].type, 'executable');
      assert.strictEqual(targets[1].name, 'SharedUtils');
      assert.strictEqual(targets[1].type, 'library');
      assert.strictEqual(targets[2].name, 'ServerApp');
      assert.strictEqual(targets[2].type, 'sources');
    });

    it('should insert source file into single-line target_sources correctly', () => {
      const cmakeLists = 'target_sources(MyDaemon PRIVATE src/daemon.cpp)';
      const updated = CMakeListsModifier.insertSourceIntoTarget(cmakeLists, 'MyDaemon', 'src/worker.cpp');
      assert.strictEqual(updated, 'target_sources(MyDaemon PRIVATE src/daemon.cpp src/worker.cpp)');
    });

    it('should insert source file into existing target_sources or add_executable block', () => {
      const cmakeLists = `
        add_executable(MyDaemon
          src/daemon.cpp
        )
      `;

      const updated = CMakeListsModifier.insertSourceIntoTarget(cmakeLists, 'MyDaemon', 'src/worker.cpp');
      assert.ok(updated.includes('src/worker.cpp'));
      assert.ok(updated.indexOf('src/daemon.cpp') < updated.indexOf('src/worker.cpp'));

      // If already present, should be idempotent
      const duplicate = CMakeListsModifier.insertSourceIntoTarget(updated, 'MyDaemon', 'src/worker.cpp');
      assert.strictEqual(duplicate, updated);
    });
  });

  describe('CMakeManager Hybrid Lifecycle', () => {
    it('should use FileAPI when reply directory exists and fall back to static parser when absent', async () => {
      const cmakeLists = path.join(tempDir, 'CMakeLists.txt');
      fs.writeFileSync(
        cmakeLists,
        `
        cmake_minimum_required(VERSION 3.20)
        project(HybridTest)
        add_executable(App main.cpp)
        include_directories(include)
      `,
        'utf8'
      );
      fs.writeFileSync(path.join(tempDir, 'main.cpp'), 'int main() { return 0; }\n', 'utf8');

      mockVscode.workspace.workspaceFolders = [
        {
          uri: vscode.Uri.file(tempDir),
          name: 'HybridTest',
          index: 0
        }
      ];

      const detector = new CompilerDetector();
      const extractor = new SystemIncludeExtractor();
      const manager = new CMakeManager(detector, extractor);

      // 1. Initial refresh with no build directory -> uses Static Parser
      await manager.refresh(false);
      assert.strictEqual(manager.getIsUsingFileApi(), false);
      assert.ok(manager.getActiveProject());

      // 2. Now simulate CMake FileAPI directory
      const replyDir = path.join(tempDir, 'build', '.cmake', 'api', 'v1', 'reply');
      fs.mkdirSync(replyDir, { recursive: true });

      const indexJson = {
        reply: {
          'codemodel-v2': { jsonFile: 'codemodel-v2.json' }
        }
      };
      fs.writeFileSync(path.join(replyDir, 'index-fileapi.json'), JSON.stringify(indexJson));

      const codeModelJson = {
        configurations: [
          {
            name: 'Debug',
            targets: [{ name: 'App', jsonFile: 'target-App.json' }]
          }
        ]
      };
      fs.writeFileSync(path.join(replyDir, 'codemodel-v2.json'), JSON.stringify(codeModelJson));

      const appTargetJson = {
        name: 'App',
        type: 'EXECUTABLE',
        artifacts: [{ path: 'App.exe' }],
        sources: [{ path: 'main.cpp', compileGroupIndex: 0 }],
        compileGroups: [
          {
            language: 'CXX',
            includes: [{ path: path.join(tempDir, 'include') }],
            preprocessorDefinitions: [{ define: 'FILEAPI_ACTIVE=1' }]
          }
        ]
      };
      fs.writeFileSync(path.join(replyDir, 'target-App.json'), JSON.stringify(appTargetJson));

      // 3. Re-refresh -> switches seamlessly to FileAPI
      await manager.refresh(false);
      assert.strictEqual(manager.getIsUsingFileApi(), true);
      assert.ok(manager.getActiveProject()?.compileDefinitions.includes('FILEAPI_ACTIVE=1'));

      manager.dispose();
    });
  });

  describe('CMakeLanguageService (IntelliSense for CMakeLists.txt)', () => {
    it('should provide command, variable, keyword, and snippet completions', () => {
      const service = new CMakeLanguageService();
      const mockDoc = {
        lineAt: () => ({ text: 'add_' }),
        getText: () => 'add_'
      } as any;

      const items = service.provideCompletions(mockDoc, new vscode.Position(0, 4));
      assert.ok(items.length > 50);

      const addExec = items.find((i) => i.label === 'add_executable' && i.kind === vscode.CompletionItemKind.Function);
      assert.ok(addExec);
      assert.strictEqual(addExec.kind, vscode.CompletionItemKind.Function);

      const addExecSnippet = items.find((i) => i.label === 'add_executable' && i.kind === vscode.CompletionItemKind.Snippet);
      assert.ok(addExecSnippet);

      const pubKeyword = items.find((i) => i.label === 'PUBLIC' && i.kind === vscode.CompletionItemKind.Keyword);
      assert.ok(pubKeyword);
      assert.strictEqual(pubKeyword.kind, vscode.CompletionItemKind.Keyword);

      const cxxStd = items.find((i) => i.label === 'CMAKE_CXX_STANDARD' && i.kind === vscode.CompletionItemKind.Variable);
      assert.ok(cxxStd);
      assert.strictEqual(cxxStd.kind, vscode.CompletionItemKind.Variable);

      service.dispose();
    });

    it('should provide rich hover documentation for CMake commands, variables, and keywords', () => {
      const service = new CMakeLanguageService();

      // 1. Command hover
      const docCommand = {
        getWordRangeAtPosition: () => new vscode.Range(0, 0, 0, 14),
        getText: () => 'add_executable'
      } as any;
      const cmdHover = service.provideHover(docCommand, new vscode.Position(0, 5));
      assert.ok(cmdHover);
      const cmdText = (cmdHover.contents[0] as vscode.MarkdownString).value;
      assert.ok(cmdText.includes('CMake Command: `add_executable`'));

      // 2. Variable hover
      const docVar = {
        getWordRangeAtPosition: () => new vscode.Range(0, 0, 0, 18),
        getText: () => 'CMAKE_CXX_STANDARD'
      } as any;
      const varHover = service.provideHover(docVar, new vscode.Position(0, 5));
      assert.ok(varHover);
      const varText = (varHover.contents[0] as vscode.MarkdownString).value;
      assert.ok(varText.includes('CMake Variable: `CMAKE_CXX_STANDARD`'));

      // 3. Keyword hover
      const docKeyword = {
        getWordRangeAtPosition: () => new vscode.Range(0, 0, 0, 6),
        getText: () => 'PUBLIC'
      } as any;
      const kwHover = service.provideHover(docKeyword, new vscode.Position(0, 2));
      assert.ok(kwHover);
      const kwText = (kwHover.contents[0] as vscode.MarkdownString).value;
      assert.ok(kwText.includes('CMake Scope/Keyword: `PUBLIC`'));

      // 4. Unknown identifier returns null
      const docUnknown = {
        getWordRangeAtPosition: () => new vscode.Range(0, 0, 0, 7),
        getText: () => 'unknown_id'
      } as any;
      const unknownHover = service.provideHover(docUnknown, new vscode.Position(0, 2));
      assert.strictEqual(unknownHover, null);

      service.dispose();
    });
  });

  describe('ProjectBuildController', () => {
    it('should handle build execution and target launcher triggers', async () => {
      const cmakeLists = path.join(tempDir, 'CMakeLists.txt');
      fs.writeFileSync(cmakeLists, 'cmake_minimum_required(VERSION 3.20)\nproject(BuildTest)\n', 'utf8');

      const detector = new CompilerDetector();
      const extractor = new SystemIncludeExtractor();
      const cmakeManager = new CMakeManager(detector, extractor);
      const buildController = new ProjectBuildController(cmakeManager, null);

      // Verify controller initial state
      assert.ok(buildController.getProblemMatcher());

      // Mock runProcess to simulate successful build
      (buildController as any).runProcess = async () => true;

      const buildOk = await buildController.buildProject(tempDir);
      assert.strictEqual(buildOk, true);

      // Verify buildAndRunProject and buildAndDebugProject flow without throwing
      await buildController.buildAndRunProject(tempDir);
      await buildController.buildAndDebugProject(tempDir);

      buildController.dispose();
      cmakeManager.dispose();
    });
  });
});
