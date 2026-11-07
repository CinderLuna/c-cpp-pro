import * as vscode from 'vscode';
import * as path from 'path';
import { StlRemoteProvider } from './intelligence/stl-remote-provider';
import { ClangdInstaller } from './substrate/installer';
import { DaemonManager } from './substrate/daemon-manager';
import { CompilerDetector } from './prober/compiler-detector';
import { SystemIncludeExtractor } from './prober/system-includes';
import { FlagSynthesizer } from './prober/flag-synthesizer';
import {
  CppProDebugConfigurationProvider,
  CppProDebugAdapterDescriptorFactory
} from './debugger/dap-session';
import { CppEvaluatableExpressionProvider } from './debugger/process-picker';
import { CppProTaskProvider } from './tasks/task-provider';
import { CMakeWatcher } from './bridge/cmake-watcher';
import { InactiveRegionsManager } from './bridge/inactive-regions';
import { PostfixCompletionProvider } from './intelligence/postfix-provider';
import { PreprocessorDirectiveCompletionProvider } from './intelligence/directive-completion-provider';
import { CppProCodeActionProvider } from './intelligence/code-actions';
import { InlayHintManager } from './intelligence/inlay-hints';
import { ReferenceCountCodeLensProvider } from './intelligence/reference-count-provider';
import { RunController } from './tasks/run-controller';
import { StlUsageCollector } from './telemetry/stl-collector';
import { StlRankingTable } from './telemetry/ranking-table';
import { BatchDispatcher } from './telemetry/batch-dispatcher';
import { SolutionManager } from './solution/solution-manager';
import { SolutionTaskProvider } from './solution/solution-task-provider';
import { DiagnosticsLogger } from './diagnostics/diagnostics-logger';
import { DoxygenCompletionProvider } from './documentation/doxygen-generator';
import { ClangTidyManager } from './analysis/clang-tidy-manager';
import { VsEnvironmentManager } from './tasks/vs-environment-manager';
import { VcpkgAdvisor } from './ecosystem/vcpkg-advisor';
import { CppProConfigurationTool } from './ai/language-model-tool';
import { ProfileManager } from './config/profile-manager';
import { MemoryLayoutInspector } from './inspector/memory-layout-inspector';
import { IncludeVisualizerManager } from './analysis/include-visualizer';
import { CppTestController } from './testing/test-controller';
import { MacroEvaluatorManager } from './intelligence/macro-evaluator';
import { DisassemblyContentProvider } from './compiler/disassembly-view';
import { HierarchyGraphManager } from './hierarchy/hierarchy-graph';
import { CMakeManager } from './cmake/cmake-manager';
import { CMakeCodeActionProvider } from './cmake/cmake-modifier';
import { registerAllCommands } from './commands/command-registry';
import { CppIncludeDocumentLinkProvider } from './intelligence/document-links';

let daemonManager: DaemonManager | null = null;
let installer: ClangdInstaller | null = null;
let detector: CompilerDetector | null = null;
let extractor: SystemIncludeExtractor | null = null;
let synthesizer: FlagSynthesizer | null = null;
let taskProvider: CppProTaskProvider | null = null;
let cmakeWatcher: CMakeWatcher | null = null;
let inactiveRegionsManager: InactiveRegionsManager | null = null;
let runController: RunController | null = null;
let stlCollector: StlUsageCollector | null = null;
let rankingTable: StlRankingTable | null = null;
let batchDispatcher: BatchDispatcher | null = null;
let solutionManager: SolutionManager | null = null;
let solutionTaskProvider: SolutionTaskProvider | null = null;
let profileManager: ProfileManager | null = null;
let cmakeManager: CMakeManager | null = null;
let telemetryOutputChannel: vscode.OutputChannel | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Activating C/C++ Pro extension...');

  stlCollector = new StlUsageCollector();
  rankingTable = new StlRankingTable();
  const storagePath = context.globalStorageUri?.fsPath ?? context.storageUri?.fsPath;
  if (storagePath) {
    StlRemoteProvider.getInstance().setCacheDirectory(path.join(storagePath, 'stl_docs'));
  }
  batchDispatcher = new BatchDispatcher(stlCollector, storagePath);
  batchDispatcher.start();

  installer = new ClangdInstaller(context);
  daemonManager = new DaemonManager(context, installer, rankingTable);
  detector = new CompilerDetector();
  extractor = new SystemIncludeExtractor();
  synthesizer = new FlagSynthesizer(detector, extractor);
  taskProvider = new CppProTaskProvider(detector);
  inactiveRegionsManager = new InactiveRegionsManager();
  runController = new RunController(detector);

  // Restore saved Visual Studio Developer Environment if configured
  await VsEnvironmentManager.restoreSavedEnvironment(context);

  // Initialize Multi-Target Configuration Profile Manager
  profileManager = new ProfileManager(detector, async () => {
    await daemonManager?.restart();
  });
  context.subscriptions.push(profileManager);

  // Initialize CMake Static Subsystem
  cmakeManager = new CMakeManager(detector, extractor, async () => {
    await daemonManager?.restart();
  });
  await cmakeManager.initialize();
  context.subscriptions.push(cmakeManager);

  // Watch for compilation databases, CMakeLists, and seamless auto-reload
  cmakeWatcher = new CMakeWatcher(
    async () => {
      await daemonManager?.restart();
    },
    async (uri) => {
      if (uri.fsPath.endsWith('CMakeLists.txt') || uri.fsPath.endsWith('.cmake')) {
        await cmakeManager?.refresh();
      }
    }
  );

  // Wire inactive regions notification from clangd to inactive regions renderer
  context.subscriptions.push(
    daemonManager.onInactiveRegions((params) => {
      inactiveRegionsManager?.handleInactiveRegions(params);
    })
  );

  context.subscriptions.push(
    daemonManager,
    cmakeWatcher,
    inactiveRegionsManager,
    runController,
    batchDispatcher,
    ClangTidyManager.getInstance(),
    { dispose: () => DiagnosticsLogger.dispose() }
  );

  // Register Debugger Subsystem
  const debugConfigProvider = new CppProDebugConfigurationProvider();
  const debugAdapterFactory = new CppProDebugAdapterDescriptorFactory();

  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('c-cpp-pro-debug', debugConfigProvider),
    vscode.debug.registerDebugAdapterDescriptorFactory('c-cpp-pro-debug', debugAdapterFactory)
  );

  // Register Build Task Provider
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(CppProTaskProvider.taskType, taskProvider)
  );

  // Initialize Visual Studio Solution (.sln & .slnx) Subsystem
  solutionManager = new SolutionManager(detector, extractor, async () => {
    await daemonManager?.restart();
  });
  await solutionManager.initialize();

  solutionTaskProvider = new SolutionTaskProvider(
    detector,
    () => solutionManager?.getActiveSolution() ?? null,
    () =>
      solutionManager?.getActiveConfiguration() ?? {
        configuration: 'Debug',
        platform: 'x64',
        key: 'Debug|x64'
      }
  );

  context.subscriptions.push(
    solutionManager,
    vscode.tasks.registerTaskProvider(SolutionTaskProvider.taskType, solutionTaskProvider)
  );

  // Register Language Model Tool (#cpp) for Copilot Chat
  if (typeof (vscode as any).lm?.registerTool === 'function') {
    const configTool = new CppProConfigurationTool(detector, solutionManager);
    context.subscriptions.push(
      (vscode as any).lm.registerTool('c_cpp_pro_configuration', configTool)
    );
  }

  // Register Advanced Language Providers
  const cppSelector: vscode.DocumentSelector = [
    { language: 'cpp', scheme: 'file' },
    { language: 'c', scheme: 'file' },
    { language: 'cuda-cpp', scheme: 'file' }
  ];

  const postfixProvider = new PostfixCompletionProvider();
  const codeActionProvider = new CppProCodeActionProvider();
  const inlayHintManager = new InlayHintManager();
  const referenceCountProvider = new ReferenceCountCodeLensProvider(() => daemonManager);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(cppSelector, referenceCountProvider),
    referenceCountProvider,
    vscode.languages.registerCompletionItemProvider(
      cppSelector,
      postfixProvider,
      ...PostfixCompletionProvider.triggerCharacters
    ),
    vscode.languages.registerCompletionItemProvider(
      cppSelector,
      new DoxygenCompletionProvider(),
      ...DoxygenCompletionProvider.triggerCharacters
    ),
    vscode.languages.registerCompletionItemProvider(
      cppSelector,
      new PreprocessorDirectiveCompletionProvider(),
      ...PreprocessorDirectiveCompletionProvider.triggerCharacters
    ),
    vscode.languages.registerCodeActionsProvider(
      cppSelector,
      codeActionProvider,
      {
        providedCodeActionKinds: CppProCodeActionProvider.providedCodeActionKinds
      }
    ),
    vscode.languages.registerCodeActionsProvider(
      cppSelector,
      ClangTidyManager.getInstance(),
      {
        providedCodeActionKinds: ClangTidyManager.providedCodeActionKinds
      }
    ),
    vscode.languages.registerCodeActionsProvider(
      cppSelector,
      new VcpkgAdvisor(),
      {
        providedCodeActionKinds: VcpkgAdvisor.providedCodeActionKinds
      }
    ),
    vscode.languages.registerCodeActionsProvider(
      cppSelector,
      new CMakeCodeActionProvider(),
      {
        providedCodeActionKinds: CMakeCodeActionProvider.providedCodeActionKinds
      }
    ),
    vscode.languages.registerEvaluatableExpressionProvider(
      cppSelector,
      new CppEvaluatableExpressionProvider()
    ),
    vscode.languages.registerDocumentLinkProvider(
      cppSelector,
      new CppIncludeDocumentLinkProvider()
    ),
    inlayHintManager
  );

  // Inspection & Analysis Managers: Memory Layout, Include Visualizer, Test Controller, Macro Evaluator, Disassembly View & Hierarchy Graph
  const memoryLayoutInspector = new MemoryLayoutInspector();
  const includeVisualizer = new IncludeVisualizerManager();
  const testController = new CppTestController();
  const macroEvaluator = new MacroEvaluatorManager();
  const disasmProvider = new DisassemblyContentProvider(detector);
  const hierarchyManager = new HierarchyGraphManager();
  context.subscriptions.push(
    memoryLayoutInspector,
    includeVisualizer,
    testController,
    macroEvaluator,
    disasmProvider,
    hierarchyManager,
    vscode.workspace.registerTextDocumentContentProvider(DisassemblyContentProvider.scheme, disasmProvider)
  );

  // Register Commands via Command Registry
  context.subscriptions.push(
    ...registerAllCommands({
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
      memoryLayoutInspector,
      includeVisualizer,
      testController,
      macroEvaluator,
      disasmProvider,
      hierarchyManager,
      getTelemetryOutputChannel: () => {
        if (!telemetryOutputChannel) {
          telemetryOutputChannel = vscode.window.createOutputChannel("C/C++ Pro Telemetry Buffer");
          context.subscriptions.push(telemetryOutputChannel);
        }
        return telemetryOutputChannel;
      }
    })
  );

  // On-Save Scanner: Passively scan C++ source files for STL references
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!stlCollector?.isTelemetryAllowed()) return;
      if (doc.languageId !== 'cpp' && doc.languageId !== 'c') return;
      const text = doc.getText();
      const matches = text.matchAll(/\bstd::(?:ranges::|views::|chrono::|filesystem::)?[a-zA-Z0-9_]+(?:::?[a-zA-Z0-9_]+)*/g);
      for (const match of matches) {
        stlCollector.recordAstCall(match[0]);
      }
    })
  );

  // Start the language server daemon
  await daemonManager.start();
}

export async function deactivate(): Promise<void> {
  if (solutionManager) {
    solutionManager.dispose();
    solutionManager = null;
  }
  if (cmakeManager) {
    cmakeManager.dispose();
    cmakeManager = null;
  }
  if (batchDispatcher) {
    await batchDispatcher.flushNow();
    batchDispatcher.dispose();
    batchDispatcher = null;
  }
  if (daemonManager) {
    await daemonManager.stop();
    daemonManager = null;
  }
  if (profileManager) {
    profileManager.dispose();
    profileManager = null;
  }
  if (telemetryOutputChannel) {
    telemetryOutputChannel.dispose();
    telemetryOutputChannel = null;
  }
  ClangTidyManager.getInstance().dispose();
}

