import * as vscode from 'vscode';
import { DaemonManager } from '../substrate/daemon-manager';
import { ClangdInstaller } from '../substrate/installer';
import { CompilerDetector } from '../prober/compiler-detector';
import { SystemIncludeExtractor } from '../prober/system-includes';
import { FlagSynthesizer } from '../prober/flag-synthesizer';
import { RunController } from '../tasks/run-controller';
import { StlUsageCollector } from '../telemetry/stl-collector';
import { BatchDispatcher } from '../telemetry/batch-dispatcher';
import { SolutionManager } from '../solution/solution-manager';
import { ProfileManager } from '../config/profile-manager';
import { CMakeManager } from '../cmake/cmake-manager';
import { MemoryLayoutInspector, StructLayout } from '../inspector/memory-layout-inspector';
import { IncludeVisualizerManager } from '../analysis/include-visualizer';
import { CppTestController } from '../testing/test-controller';
import { MacroEvaluatorManager } from '../intelligence/macro-evaluator';
import { DisassemblyContentProvider } from '../compiler/disassembly-view';
import { HierarchyGraphManager } from '../hierarchy/hierarchy-graph';
import { ConfigPanel } from '../webview/config-panel';
import { SmartDefinitionManager } from '../intelligence/smart-definition';
import { DiagnosticsLogger } from '../diagnostics/diagnostics-logger';
import { IndexManager } from '../diagnostics/index-manager';
import { DirectiveNavigator } from '../navigation/directive-navigator';
import { DoxygenGenerator } from '../documentation/doxygen-generator';
import { ClangTidyManager } from '../analysis/clang-tidy-manager';
import { VsEnvironmentManager } from '../tasks/vs-environment-manager';
import { ProcessPicker } from '../debugger/process-picker';
import { ProjectCreator } from '../project/project-creator';
import { CMakeListsModifier } from '../cmake/cmake-modifier';
import { ProjectBuildController } from '../tasks/project-build-controller';
import * as path from 'path';
import * as fs from 'fs';

export interface CommandRegistryContext {
  extensionContext: vscode.ExtensionContext;
  daemonManager: DaemonManager | null;
  installer: ClangdInstaller | null;
  detector: CompilerDetector | null;
  extractor: SystemIncludeExtractor | null;
  synthesizer: FlagSynthesizer | null;
  runController: RunController | null;
  stlCollector: StlUsageCollector | null;
  batchDispatcher: BatchDispatcher | null;
  solutionManager: SolutionManager | null;
  profileManager: ProfileManager | null;
  cmakeManager: CMakeManager | null;
  projectBuildController: ProjectBuildController | null;
  memoryLayoutInspector: MemoryLayoutInspector;
  includeVisualizer: IncludeVisualizerManager;
  testController: CppTestController;
  macroEvaluator: MacroEvaluatorManager;
  disasmProvider: DisassemblyContentProvider;
  hierarchyManager: HierarchyGraphManager;
  getTelemetryOutputChannel: () => vscode.OutputChannel;
}

/**
 * Registers all 41 C/C++ Pro user-facing commands and returns their disposables.
 */
export function registerAllCommands(ctx: CommandRegistryContext): vscode.Disposable[] {
  const {
    extensionContext: context,
    daemonManager,
    installer,
    detector,
    extractor,
    synthesizer,
    runController,
    stlCollector,
    batchDispatcher,
    solutionManager,
    profileManager,
    cmakeManager,
    projectBuildController,
    memoryLayoutInspector,
    includeVisualizer,
    testController,
    macroEvaluator,
    disasmProvider,
    hierarchyManager,
    getTelemetryOutputChannel
  } = ctx;

  return [
    vscode.commands.registerCommand('c-cpp-pro.createProject', async () => {
      await ProjectCreator.promptAndCreate(context, detector);
    }),
    vscode.commands.registerCommand('c-cpp-pro.openSettings', () => {
      if (!detector || !synthesizer) return;
      ConfigPanel.render(
        context.extensionUri,
        detector,
        synthesizer,
        async () => {
          await daemonManager?.restart();
        }
      );
    }),
    vscode.commands.registerCommand(
      'c-cpp-pro.inspectMemoryLayout',
      async (uriOrArgs?: unknown, line?: number, character?: number, structName?: string): Promise<StructLayout | null> => {
        return await memoryLayoutInspector.inspectCurrentStruct(uriOrArgs, line, character, structName);
      }
    ),
    vscode.commands.registerCommand('c-cpp-pro.analyzeIncludes', () => {
      includeVisualizer.analyzeActiveDocument();
    }),
    vscode.commands.registerCommand('c-cpp-pro.visualizeTimeTrace', async (uri?: vscode.Uri) => {
      await includeVisualizer.visualizeTimeTraceFile(uri);
    }),
    vscode.commands.registerCommand('c-cpp-pro.refreshTests', async () => {
      const count = await testController.refreshAll();
      vscode.window.showInformationMessage(`C/C++ Pro: Discovered ${count} C/C++ unit test(s).`);
    }),
    vscode.commands.registerCommand('c-cpp-pro.expandMacro', () => {
      macroEvaluator.expandMacroAtCursor();
    }),
    vscode.commands.registerCommand('c-cpp-pro.evaluateConstexpr', () => {
      macroEvaluator.evaluateConstexprAtCursor();
    }),
    vscode.commands.registerCommand('c-cpp-pro.viewDisassembly', async () => {
      await disasmProvider.openDisassemblyForActiveEditor();
    }),
    vscode.commands.registerCommand('c-cpp-pro.setDisassemblyOptimizationLevel', async () => {
      const selected = await vscode.window.showQuickPick(['O0', 'O1', 'O2', 'O3', 'Os', 'Ofast'], {
        placeHolder: 'Select compiler optimization level for disassembly'
      });
      if (selected) {
        disasmProvider.setOptimizationLevel(selected as any);
        vscode.window.showInformationMessage(`C/C++ Pro: Disassembly optimization set to -${selected}.`);
      }
    }),
    vscode.commands.registerCommand('c-cpp-pro.showTypeHierarchy', () => {
      hierarchyManager.showTypeHierarchy();
    }),
    vscode.commands.registerCommand('c-cpp-pro.restartServer', async () => {
      await daemonManager?.restart();
    }),
    vscode.commands.registerCommand('c-cpp-pro.toggleDimInactiveRegions', async () => {
      const config = vscode.workspace.getConfiguration('c-cpp-pro');
      const current = config.get<boolean>('inactiveRegionsDimming', true);
      await config.update('inactiveRegionsDimming', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        `C/C++ Pro: Inactive regions dimming ${!current ? 'enabled' : 'disabled'}.`
      );
    }),
    vscode.commands.registerCommand('c-cpp-pro.switchSourceHeader', async () => {
      const switched = await SmartDefinitionManager.switchSourceHeader();
      if (!switched && daemonManager) {
        await daemonManager.switchSourceHeader();
      }
    }),
    vscode.commands.registerCommand(
      'c-cpp-pro.findReferences',
      async (uriOrArgs?: unknown, line?: number, character?: number): Promise<void> => {
        let targetUri: vscode.Uri | undefined;
        let targetPosition: vscode.Position | undefined;

        if (typeof uriOrArgs === 'string') {
          targetUri = vscode.Uri.parse(uriOrArgs);
          if (typeof line === 'number' && typeof character === 'number') {
            targetPosition = new vscode.Position(line, character);
          }
        } else if (Array.isArray(uriOrArgs) && uriOrArgs.length >= 3) {
          const first = uriOrArgs[0];
          targetUri = typeof first === 'string' ? vscode.Uri.parse(first) : (first instanceof vscode.Uri ? first : undefined);
          targetPosition = new vscode.Position(Number(uriOrArgs[1]), Number(uriOrArgs[2]));
        } else if (uriOrArgs && typeof uriOrArgs === 'object') {
          if (uriOrArgs instanceof vscode.Uri) {
            targetUri = uriOrArgs;
            if (typeof line === 'number' && typeof character === 'number') {
              targetPosition = new vscode.Position(line, character);
            }
          } else {
            const argObj = uriOrArgs as {
              uri?: unknown;
              line?: unknown;
              character?: unknown;
              position?: { line?: unknown; character?: unknown };
            };
            if (argObj.uri) {
              targetUri =
                typeof argObj.uri === 'string'
                  ? vscode.Uri.parse(argObj.uri)
                  : argObj.uri instanceof vscode.Uri
                  ? argObj.uri
                  : undefined;
              if (typeof argObj.line === 'number' && typeof argObj.character === 'number') {
                targetPosition = new vscode.Position(argObj.line, argObj.character);
              } else if (
                argObj.position &&
                typeof argObj.position.line === 'number' &&
                typeof argObj.position.character === 'number'
              ) {
                targetPosition = new vscode.Position(argObj.position.line, argObj.position.character);
              }
            }
          }
        }

        try {
          if (targetUri) {
            const doc = await vscode.workspace.openTextDocument(targetUri);
            const editor = await vscode.window.showTextDocument(doc, { preserveFocus: false });
            if (targetPosition) {
              editor.selection = new vscode.Selection(targetPosition, targetPosition);
              editor.revealRange(
                new vscode.Range(targetPosition, targetPosition),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport
              );
            }
            await vscode.commands.executeCommand('editor.action.findReferences');
            return;
          }
        } catch {
          // Fall through to active editor fallback
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
          await vscode.commands.executeCommand('editor.action.findReferences');
        }
      }
    ),
    vscode.commands.registerCommand('c-cpp-pro.installClangd', async () => {
      try {
        await installer?.installLatest();
        vscode.window.showInformationMessage('C/C++ Pro: clangd installed successfully. Restarting server...');
        await daemonManager?.restart();
      } catch (err: any) {
        vscode.window.showErrorMessage(`C/C++ Pro: Installation failed: ${err.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand('c-cpp-pro.detectCompilers', async () => {
      if (!detector) return;
      const compilers = await detector.detectAllCompilers(true);
      const items = compilers.map((c) => ({
        label: c.name,
        description: c.path,
        detail: `Type: ${c.type}${c.version ? ` | Version: ${c.version}` : ''}`
      }));
      vscode.window.showQuickPick(items, {
        placeHolder: `Detected ${compilers.length} C/C++ Compilers`
      });
    }),
    vscode.commands.registerCommand('c-cpp-pro.generateCompileFlags', async () => {
      if (!synthesizer) return;
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('C/C++ Pro: No workspace folder open.');
        return;
      }
      try {
        const generated = await synthesizer.synthesizeFlagsFile(folders[0].uri.fsPath, {
          forceOverwrite: true
        });
        vscode.window.showInformationMessage(
          `C/C++ Pro: Generated compile_flags.txt at ${generated}`
        );
        await daemonManager?.restart();
      } catch (err: any) {
        vscode.window.showErrorMessage(`C/C++ Pro: Error generating flags: ${err.message ?? err}`);
      }
    }),
    vscode.commands.registerCommand('c-cpp-pro.runFile', async () => {
      await runController?.runFile();
    }),
    vscode.commands.registerCommand('c-cpp-pro.debugFile', async () => {
      await runController?.debugFile();
    }),
    vscode.commands.registerCommand('c-cpp-pro.openDocs', async (urlOrSymbol?: string) => {
      await SmartDefinitionManager.openDocumentation(urlOrSymbol);
    }),
    vscode.commands.registerCommand(
      'c-cpp-pro.onStlItemAccepted',
      async (symbolKey: string, chainedCommand?: vscode.Command) => {
        stlCollector?.recordCompletionAccepted({ label: symbolKey });
        if (chainedCommand) {
          await vscode.commands.executeCommand(chainedCommand.command, ...(chainedCommand.arguments ?? []));
        }
      }
    ),
    vscode.commands.registerCommand('c-cpp-pro.inspectTelemetry', () => {
      const counts = stlCollector?.getPendingCounts() ?? {};
      const totalSymbols = Object.keys(counts).length;
      const totalInvocations = Object.values(counts).reduce((a, b) => a + b, 0);
      const channel = getTelemetryOutputChannel();
      channel.clear();
      channel.appendLine('=== C/C++ Pro Anonymous STL Telemetry Buffer ===');
      channel.appendLine(`Tracked Distinct Symbols : ${totalSymbols}`);
      channel.appendLine(`Total Recorded Calls     : ${totalInvocations}`);
      channel.appendLine('Privacy Policy           : ISO C++ Standard Library Allowlist (Zero Code / Zero PII)');
      channel.appendLine('--------------------------------------------------------------------------------');
      channel.appendLine(JSON.stringify(counts, null, 2));
      channel.show();
    }),
    vscode.commands.registerCommand('c-cpp-pro.flushTelemetry', async () => {
      const success = await batchDispatcher?.flushNow(1);
      vscode.window.showInformationMessage(
        `C/C++ Pro: Telemetry batch ${success ? 'transmitted to server' : 'saved to offline queue'}.`
      );
    }),
    vscode.commands.registerCommand('c-cpp-pro.solutionMenu', async () => {
      await solutionManager?.showSolutionMenu();
    }),
    vscode.commands.registerCommand('c-cpp-pro.selectSolution', async () => {
      await solutionManager?.selectSolution();
    }),
    vscode.commands.registerCommand('c-cpp-pro.selectSolutionConfiguration', async () => {
      await solutionManager?.selectConfiguration();
    }),
    vscode.commands.registerCommand('c-cpp-pro.buildSolution', async () => {
      await solutionManager?.runMSBuildTask('Build');
    }),
    vscode.commands.registerCommand('c-cpp-pro.rebuildSolution', async () => {
      await solutionManager?.runMSBuildTask('Rebuild');
    }),
    vscode.commands.registerCommand('c-cpp-pro.cleanSolution', async () => {
      await solutionManager?.runMSBuildTask('Clean');
    }),
    vscode.commands.registerCommand('c-cpp-pro.generateCompilationDbFromSolution', async () => {
      const generated = await solutionManager?.synthesizeCompilationDatabase();
      if (generated) {
        vscode.window.showInformationMessage(`C/C++ Pro: Generated compile_commands.json at ${generated}`);
      } else {
        vscode.window.showWarningMessage(
          'C/C++ Pro: No solution or project files found to generate compile_commands.json.'
        );
      }
    }),
    vscode.commands.registerCommand('c-cpp-pro.logDiagnostics', async () => {
      if (!detector || !extractor) return;
      await DiagnosticsLogger.logDiagnostics(detector, extractor, solutionManager, stlCollector);
    }),
    vscode.commands.registerCommand('c-cpp-pro.resetIndex', async () => {
      await IndexManager.resetIndex(
        undefined,
        async () => {
          await daemonManager?.start();
        },
        async () => {
          await daemonManager?.stop();
        }
      );
    }),
    vscode.commands.registerCommand('c-cpp-pro.goToNextDirectiveInGroup', async () => {
      await DirectiveNavigator.goToNextDirective();
    }),
    vscode.commands.registerCommand('c-cpp-pro.goToPrevDirectiveInGroup', async () => {
      await DirectiveNavigator.goToPrevDirective();
    }),
    vscode.commands.registerCommand('c-cpp-pro.generateDoxygenComment', async () => {
      await DoxygenGenerator.generateForActiveEditor();
    }),
    vscode.commands.registerCommand('c-cpp-pro.runClangTidyOnActiveFile', async () => {
      await ClangTidyManager.getInstance().runOnActiveFile();
    }),
    vscode.commands.registerCommand('c-cpp-pro.clearCodeAnalysisDiagnostics', () => {
      ClangTidyManager.getInstance().clearDiagnostics();
    }),
    vscode.commands.registerCommand('c-cpp-pro.setVsDeveloperEnvironment', async () => {
      if (!detector) return;
      await VsEnvironmentManager.setVsDeveloperEnvironment(context, detector);
    }),
    vscode.commands.registerCommand('c-cpp-pro.clearVsDeveloperEnvironment', () => {
      VsEnvironmentManager.clearVsDeveloperEnvironment(context);
    }),
    vscode.commands.registerCommand('c-cpp-pro.copyToClipboard', async (text: string) => {
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage(`C/C++ Pro: Copied "${text}" to clipboard.`);
    }),
    vscode.commands.registerCommand('c-cpp-pro.runInTerminal', (command: string) => {
      if (typeof command !== 'string' || !command.trim()) {
        vscode.window.showWarningMessage('C/C++ Pro: Cannot execute empty terminal command.');
        return;
      }
      const trimmed = command.trim();
      if (/[\r\n]/.test(trimmed)) {
        vscode.window.showErrorMessage('C/C++ Pro: Multiline commands are not permitted.');
        return;
      }
      const allowedPrefixes = ['vcpkg ', 'conan ', 'vcpkg.exe ', 'conan.exe '];
      const isAllowedPrefix = allowedPrefixes.some((prefix) => trimmed.startsWith(prefix));
      if (!isAllowedPrefix) {
        vscode.window.showErrorMessage(`C/C++ Pro: Command '${trimmed}' is not an authorized package manager command.`);
        return;
      }
      if (/[;&|`$]/.test(trimmed)) {
        vscode.window.showErrorMessage('C/C++ Pro: Command contains disallowed shell metacharacters.');
        return;
      }
      const term = vscode.window.createTerminal('C/C++ Pro Package Manager');
      term.show();
      term.sendText(trimmed);
    }),
    vscode.commands.registerCommand('c-cpp-pro.selectProfile', async () => {
      await profileManager?.selectProfile();
    }),
    vscode.commands.registerCommand('c-cpp-pro.pickProcess', async () => {
      return await ProcessPicker.pickProcess();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.menu', async () => {
      await cmakeManager?.openMenu();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.rescan', async () => {
      await cmakeManager?.refresh();
      vscode.window.showInformationMessage('C/C++ Pro: Re-scanned CMakeLists.txt and updated include paths.');
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.generateCompilationDatabase', async () => {
      const target = await cmakeManager?.synthesizeCompilationDatabase();
      if (target) {
        vscode.window.showInformationMessage(`C/C++ Pro: Generated compile_commands.json from CMakeLists.txt at ${target}`);
      } else {
        vscode.window.showWarningMessage('C/C++ Pro: Could not generate compile_commands.json.');
      }
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.selectConfigurePreset', async () => {
      await cmakeManager?.selectConfigurePreset();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.selectBuildPreset', async () => {
      await cmakeManager?.selectBuildPreset();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.selectLaunchTarget', async () => {
      await cmakeManager?.getTargetLauncher().selectLaunchTarget();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.debugTarget', async () => {
      await cmakeManager?.getTargetLauncher().debugTarget();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.launchTarget', () => {
      cmakeManager?.getTargetLauncher().launchTarget();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.compileActiveFile', async () => {
      await cmakeManager?.getSingleFileCompiler().compileActiveFile();
    }),
    vscode.commands.registerCommand('c-cpp-pro.cmake.addSourceToTarget', async (workspaceRoot: string, targetName: string, relativeSourcePath: string) => {
      if (!workspaceRoot || !targetName || !relativeSourcePath) return;
      const cmakeListsPath = path.join(workspaceRoot, 'CMakeLists.txt');
      if (!fs.existsSync(cmakeListsPath)) return;
      try {
        const content = fs.readFileSync(cmakeListsPath, 'utf8');
        const updated = CMakeListsModifier.insertSourceIntoTarget(content, targetName, relativeSourcePath);
        fs.writeFileSync(cmakeListsPath, updated, 'utf8');
        vscode.window.showInformationMessage(`Added ${path.basename(relativeSourcePath)} to target '${targetName}' in CMakeLists.txt`);
        await cmakeManager?.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to update CMakeLists.txt: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand('c-cpp-pro.buildProject', async () => {
      await projectBuildController?.buildProject();
    }),
    vscode.commands.registerCommand('c-cpp-pro.buildAndRunProject', async () => {
      await projectBuildController?.buildAndRunProject();
    }),
    vscode.commands.registerCommand('c-cpp-pro.buildAndDebugProject', async () => {
      await projectBuildController?.buildAndDebugProject();
    })
  ];
}
