import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CMakeProjectInfo } from './cmake-models';
import { CMakeDetector } from './cmake-detector';
import { CompilerDetector } from '../prober/compiler-detector';
import { SystemIncludeExtractor } from '../prober/system-includes';
import { NativeBridge } from '../native/native-bridge';
import { CMakeFileApiReader } from './cmake-file-api';
import { CMakePresetsParser, CMakeConfigurePreset, CMakeBuildPreset } from './cmake-presets';
import { CMakeTargetLauncher, CMakeExecutableTarget } from './cmake-target-launcher';
import { SingleFileCompiler } from './single-file-compile';

export class CMakeManager implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private activeProject: CMakeProjectInfo | null = null;
  private isUsingFileApi = false;

  private targetLauncher: CMakeTargetLauncher;
  private singleFileCompiler: SingleFileCompiler;

  private activeConfigurePreset: CMakeConfigurePreset | undefined;
  private activeBuildPreset: CMakeBuildPreset | undefined;
  private availableConfigurePresets: CMakeConfigurePreset[] = [];
  private availableBuildPresets: CMakeBuildPreset[] = [];

  constructor(
    private readonly detector: CompilerDetector,
    private readonly extractor: SystemIncludeExtractor,
    private readonly onReloadServer?: () => Promise<void>
  ) {
    this.targetLauncher = new CMakeTargetLauncher();
    this.singleFileCompiler = new SingleFileCompiler();
    this.disposables.push(this.targetLauncher, this.singleFileCompiler);

    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      66
    );
    this.statusBarItem.command = 'c-cpp-pro.cmake.menu';
    this.disposables.push(this.statusBarItem);
  }

  public getActiveProject(): CMakeProjectInfo | null {
    return this.activeProject;
  }

  public getTargetLauncher(): CMakeTargetLauncher {
    return this.targetLauncher;
  }

  public getSingleFileCompiler(): SingleFileCompiler {
    return this.singleFileCompiler;
  }

  public getIsUsingFileApi(): boolean {
    return this.isUsingFileApi;
  }

  public getIncludeDirectories(): string[] {
    return this.activeProject?.includeDirectories ?? [];
  }

  public getCompileDefinitions(): string[] {
    return this.activeProject?.compileDefinitions ?? [];
  }

  public getActiveConfigurePreset(): CMakeConfigurePreset | undefined {
    return this.activeConfigurePreset;
  }

  public getActiveBuildPreset(): CMakeBuildPreset | undefined {
    return this.activeBuildPreset;
  }

  /**
   * Initializes the CMake subsystem by loading presets, attempting FileAPI ingestion,
   * or falling back to static AST parsing.
   */
  public async initialize(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.statusBarItem.hide();
      return;
    }

    const rootPath = folders[0].uri.fsPath;
    if (!CMakeDetector.isCMakeWorkspace(rootPath)) {
      this.statusBarItem.hide();
      return;
    }

    await this.refresh();
  }

  /**
   * Refreshes CMake configuration using a hybrid approach:
   * 1. Loads CMakePresets.json / CMakeUserPresets.json if present.
   * 2. Inspects build directory for CMake FileAPI (codemodel-v2). If found, ingests 100% accurate targets and flags.
   * 3. If FileAPI is not found (e.g. unconfigured workspace), falls back to our zero-binary static AST parser.
   */
  public async refresh(reloadServer = true): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      this.statusBarItem.hide();
      return;
    }

    const rootPath = folders[0].uri.fsPath;

    // 1. Ingest Presets
    const presetsData = CMakePresetsParser.loadPresets(rootPath);
    if (presetsData) {
      this.availableConfigurePresets = presetsData.configurePresets;
      this.availableBuildPresets = presetsData.buildPresets;
      if (!this.activeConfigurePreset && presetsData.activeConfigurePreset) {
        this.activeConfigurePreset = presetsData.activeConfigurePreset;
      }
      if (!this.activeBuildPreset && presetsData.activeBuildPreset) {
        this.activeBuildPreset = presetsData.activeBuildPreset;
      }
    }

    // 2. Try CMake FileAPI ingestion first
    const replyDir = CMakeFileApiReader.findReplyDirectory(
      rootPath,
      this.activeConfigurePreset?.binaryDir
    );

    if (replyDir) {
      const parsed = CMakeFileApiReader.parseReply(rootPath, replyDir);
      if (parsed && parsed.project) {
        this.activeProject = parsed.project;
        this.isUsingFileApi = true;
        this.targetLauncher.setExecutableTargets(parsed.executableTargets);
        this.updateStatusBar();

        await this.synthesizeCompilationDatabase();

        if (reloadServer && this.onReloadServer) {
          await this.onReloadServer();
        }
        return;
      }
    }

    // 3. Fallback: Zero-binary static AST parser
    this.isUsingFileApi = false;
    const project = await NativeBridge.parseCMakeWorkspace(rootPath);
    if (!project) {
      this.activeProject = null;
      this.statusBarItem.hide();
      return;
    }

    this.activeProject = project;

    // Extract static executable targets
    const staticExecutables: CMakeExecutableTarget[] = [];
    const isWindows = process.platform === 'win32';
    const binaryExt = isWindows ? '.exe' : '';

    for (const t of project.targets) {
      if (t.type === 'executable') {
        const binCandidate = path.join(rootPath, 'build', t.name + binaryExt).replace(/\\/g, '/');
        staticExecutables.push({
          name: t.name,
          binaryPath: binCandidate,
          workingDirectory: path.join(rootPath, 'build').replace(/\\/g, '/')
        });
      }
    }
    this.targetLauncher.setExecutableTargets(staticExecutables);

    this.updateStatusBar();

    // Automatically synchronize discovered CMake includes into workspace compile_commands.json
    await this.synthesizeCompilationDatabase();

    if (reloadServer && this.onReloadServer) {
      await this.onReloadServer();
    }
  }

  /**
   * Prompts the user to switch the active CMake configure preset.
   */
  public async selectConfigurePreset(): Promise<CMakeConfigurePreset | null> {
    if (this.availableConfigurePresets.length === 0) {
      vscode.window.showInformationMessage('No configure presets defined in CMakePresets.json.');
      return null;
    }

    const items = this.availableConfigurePresets.map((p) => ({
      label: p.name === this.activeConfigurePreset?.name ? `$(check) ${p.name}` : `$(gear) ${p.name}`,
      description: p.displayName || p.generator || '',
      detail: p.description || (p.binaryDir ? `Binary directory: ${p.binaryDir}` : undefined),
      preset: p
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select active CMake configure preset'
    });

    if (!selected) return null;

    this.activeConfigurePreset = selected.preset;
    vscode.window.showInformationMessage(`Active CMake configure preset: ${this.activeConfigurePreset.name}`);
    await this.refresh();
    return this.activeConfigurePreset;
  }

  /**
   * Prompts the user to switch the active CMake build preset.
   */
  public async selectBuildPreset(): Promise<CMakeBuildPreset | null> {
    if (this.availableBuildPresets.length === 0) {
      vscode.window.showInformationMessage('No build presets defined in CMakePresets.json.');
      return null;
    }

    const items = this.availableBuildPresets.map((b) => ({
      label: b.name === this.activeBuildPreset?.name ? `$(check) ${b.name}` : `$(tools) ${b.name}`,
      description: b.displayName || (b.configurePreset ? `Config: ${b.configurePreset}` : ''),
      detail: b.description,
      preset: b
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select active CMake build preset'
    });

    if (!selected) return null;

    this.activeBuildPreset = selected.preset;
    vscode.window.showInformationMessage(`Active CMake build preset: ${this.activeBuildPreset.name}`);
    return this.activeBuildPreset;
  }

  /**
   * Synthesizes compile_commands.json directly from parsed CMake targets, sources, and include directories
   * without requiring any external cmake execution.
   */
  public async synthesizeCompilationDatabase(outputFilePath?: string): Promise<string | null> {
    if (!this.activeProject || !this.activeProject.workspaceRoot) return null;

    const workspaceRoot = this.activeProject.workspaceRoot;
    const compiler = await this.detector.getPreferredCompiler();
    const systemIncludes = compiler ? await this.extractor.extractSystemIncludes(compiler) : [];
    const compilerBin = compiler?.path || 'clang++';
    const isMsvc = compiler?.type === 'msvc';

    const cppStandard = this.activeProject.cppStandard || 'c++20';
    const cStandard = this.activeProject.cStandard || 'c11';
    const cStdMsvc = (cStandard === 'c17' || cStandard === 'c11') ? cStandard : 'c11';

    let targetFile = outputFilePath;
    if (!targetFile) {
      if (this.activeConfigurePreset && this.activeConfigurePreset.binaryDir) {
        targetFile = path.join(this.activeConfigurePreset.binaryDir, 'compile_commands.json');
      } else {
        targetFile = path.join(workspaceRoot, 'compile_commands.json');
      }
    }

    const globalIncludes = [...(this.activeProject.globalIncludeDirectories ?? [])];
    const globalDefs = [...(this.activeProject.globalCompileDefinitions ?? [])];

    // Ensure common workspace directories (src, include, inc) are present if they exist on disk
    for (const commonDir of ['src', 'include', 'inc']) {
      const fullDir = path.join(workspaceRoot, commonDir).replace(/\\/g, '/');
      if (fs.existsSync(fullDir) && !globalIncludes.includes(fullDir)) {
        globalIncludes.push(fullDir);
      }
    }

    const entries: {
      directory: string;
      command?: string;
      arguments?: string[];
      file: string;
    }[] = [];

    const seenFiles = new Set<string>();

    for (const target of this.activeProject.targets) {
      const allIncludes = Array.from(
        new Set([...target.includeDirectories, ...globalIncludes, ...systemIncludes])
      );
      const allDefs = Array.from(new Set([...target.compileDefinitions, ...globalDefs]));

      for (const src of target.sourceFiles) {
        const norm = src.replace(/\\/g, '/');
        if (seenFiles.has(norm.toLowerCase())) continue;
        seenFiles.add(norm.toLowerCase());

        const isC = /\.c$/i.test(src);
        const isHeader = /\.(h|hpp|hxx|inl|ipp)$/i.test(src);
        const args: string[] = [compilerBin];

        if (isMsvc) {
          if (isC) {
            args.push('/nologo', `/std:${cStdMsvc}`, '/TC');
          } else {
            args.push('/nologo', `/std:${cppStandard}`, '/EHsc', '/TP');
          }
          for (const def of allDefs) {
            args.push(`/D${def}`);
          }
          for (const inc of allIncludes) {
            args.push(`/I${inc.replace(/\\/g, '/')}`);
          }
          args.push('/c', norm);
        } else {
          if (isC) {
            args.push('-xc', `-std=${cStandard}`, '-Wall');
          } else {
            args.push(isHeader ? '-xc++-header' : '-xc++', `-std=${cppStandard}`, '-Wall');
          }
          for (const def of allDefs) {
            args.push(`-D${def}`);
          }
          for (const inc of allIncludes) {
            args.push(`-I${inc.replace(/\\/g, '/')}`);
          }
          args.push('-c', norm);
        }

        entries.push({
          directory: workspaceRoot.replace(/\\/g, '/'),
          arguments: args,
          file: norm
        });
      }
    }

    // If targets had no explicit source files (e.g., header-only library or globbed files),
    // scan for C/C++ files in workspace to populate compilation database
    if (entries.length === 0) {
      const sourceFiles = this.discoverWorkspaceCppFiles(workspaceRoot);
      const allIncludes = Array.from(new Set([...globalIncludes, ...systemIncludes]));

      for (const file of sourceFiles) {
        const norm = file.replace(/\\/g, '/');
        const isC = /\.c$/i.test(file);
        const isHeader = /\.(h|hpp|hxx|inl|ipp)$/i.test(file);
        const args: string[] = [compilerBin];

        if (isMsvc) {
          if (isC) {
            args.push('/nologo', `/std:${cStdMsvc}`, '/TC');
          } else {
            args.push('/nologo', `/std:${cppStandard}`, '/EHsc', '/TP');
          }
          for (const def of globalDefs) {
            args.push(`/D${def}`);
          }
          for (const inc of allIncludes) {
            args.push(`/I${inc.replace(/\\/g, '/')}`);
          }
          args.push('/c', norm);
        } else {
          if (isC) {
            args.push('-xc', `-std=${cStandard}`, '-Wall');
          } else {
            args.push(isHeader ? '-xc++-header' : '-xc++', `-std=${cppStandard}`, '-Wall');
          }
          for (const def of globalDefs) {
            args.push(`-D${def}`);
          }
          for (const inc of allIncludes) {
            args.push(`-I${inc.replace(/\\/g, '/')}`);
          }
          args.push('-c', norm);
        }

        entries.push({
          directory: workspaceRoot.replace(/\\/g, '/'),
          arguments: args,
          file: norm
        });
      }
    }

    if (entries.length > 0) {
      try {
        const jsonContent = JSON.stringify(entries, null, 2);
        if (fs.existsSync(targetFile)) {
          try {
            const existing = await fs.promises.readFile(targetFile, 'utf8');
            if (existing === jsonContent) {
              return targetFile;
            }
          } catch {
            // Read failed, proceed to write
          }
        }
        await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });
        await fs.promises.writeFile(targetFile, jsonContent, 'utf8');
        console.log(`C/C++ Pro: Statically generated compilation database with ${entries.length} files from CMakeLists.txt`);
        return targetFile;
      } catch (err) {
        console.warn('C/C++ Pro: Failed to write CMake compile_commands.json:', err);
      }
    }

    return null;
  }

  /**
   * Helper to discover C/C++ source and header files in the workspace.
   */
  private discoverWorkspaceCppFiles(workspaceRoot: string): string[] {
    const files: string[] = [];
    const ignored = new Set(['node_modules', '.git', '.vscode', '.clangd', 'dist', 'build', 'out', '.cache', 'bin', 'obj']);
    const exts = new Set(['.cpp', '.cxx', '.cc', '.c', '.h', '.hpp', '.hxx', '.cu']);

    const scan = (dir: string, depth: number) => {
      if (depth > 6 || files.length >= 200) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            if (!ignored.has(e.name.toLowerCase())) {
              scan(path.join(dir, e.name), depth + 1);
            }
          } else if (e.isFile()) {
            const ext = path.extname(e.name).toLowerCase();
            if (exts.has(ext)) {
              files.push(path.join(dir, e.name));
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    };

    scan(workspaceRoot, 0);
    return files;
  }

  /**
   * Displays the CMake interactive menu allowing inspection of discovered include directories and targets.
   */
  public async openMenu(): Promise<void> {
    if (!this.activeProject) {
      vscode.window.showInformationMessage('No CMakeLists.txt found in the active workspace.');
      return;
    }

    const incCount = this.activeProject.includeDirectories.length;
    const targetCount = this.activeProject.targets.length;
    const driverLabel = this.isUsingFileApi ? 'FileAPI' : 'Static Parser';

    const items: (vscode.QuickPickItem & { action: string })[] = [
      {
        label: `$(folder) View Discovered Include Directories (${incCount})`,
        description: `Inspect include directories extracted via ${driverLabel}`,
        action: 'showIncludes'
      },
      {
        label: `$(symbol-class) View Discovered Targets (${targetCount})`,
        description: 'Inspect executable and library targets declared in CMakeLists.txt',
        action: 'showTargets'
      },
      {
        label: '$(gear) Select Configure Preset',
        description: this.activeConfigurePreset ? `Active: ${this.activeConfigurePreset.name}` : 'Choose from CMakePresets.json',
        action: 'selectPreset'
      },
      {
        label: '$(play) Select Active Launch Target',
        description: this.targetLauncher.getActiveTarget()?.name || 'Choose executable target to run/debug',
        action: 'selectTarget'
      },
      {
        label: '$(debug-start) Debug Active CMake Target',
        description: 'Launch debugging session for active target',
        action: 'debugTarget'
      },
      {
        label: '$(check) Compile Active File (Syntax & Diagnostics)',
        description: 'Quickly compile current source file without whole project linkage',
        action: 'compileActiveFile'
      },
      {
        label: '$(refresh) Re-parse CMakeLists.txt',
        description: 'Re-scan CMakeLists.txt and refresh IntelliSense includes',
        action: 'rescan'
      },
      {
        label: '$(database) Generate compile_commands.json from CMakeLists.txt',
        description: 'Synthesize compilation database directly from parsed CMake project',
        action: 'generateDb'
      }
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `C/C++ Pro CMake Intelligence [${driverLabel}] — ${path.basename(this.activeProject.workspaceRoot)}`
    });

    if (!selected) return;

    switch (selected.action) {
      case 'showIncludes': {
        const incItems = this.activeProject.includeDirectories.map((inc) => ({
          label: `$(file-directory) ${path.basename(inc)}`,
          description: inc
        }));
        if (incItems.length === 0) {
          vscode.window.showInformationMessage('No include directories found in CMakeLists.txt.');
        } else {
          await vscode.window.showQuickPick(incItems, {
            placeHolder: `Discovered Include Directories (${incItems.length})`
          });
        }
        break;
      }

      case 'showTargets': {
        const targetItems = this.activeProject.targets.map((t) => ({
          label: `$(symbol-property) ${t.name} [${t.type}]`,
          description: `${t.sourceFiles.length} file(s), ${t.includeDirectories.length} include path(s)`,
          detail: t.sourceFiles.map((s) => path.basename(s)).join(', ')
        }));
        if (targetItems.length === 0) {
          vscode.window.showInformationMessage('No targets found in CMakeLists.txt.');
        } else {
          await vscode.window.showQuickPick(targetItems, {
            placeHolder: `Discovered CMake Targets (${targetItems.length})`
          });
        }
        break;
      }

      case 'selectPreset': {
        await this.selectConfigurePreset();
        break;
      }

      case 'selectTarget': {
        await this.targetLauncher.selectLaunchTarget();
        break;
      }

      case 'debugTarget': {
        await this.targetLauncher.debugTarget();
        break;
      }

      case 'compileActiveFile': {
        await this.singleFileCompiler.compileActiveFile();
        break;
      }

      case 'rescan': {
        await this.refresh();
        vscode.window.showInformationMessage(
          `C/C++ Pro: Successfully re-parsed CMakeLists.txt. Discovered ${this.activeProject.includeDirectories.length} include directory(ies).`
        );
        break;
      }

      case 'generateDb': {
        const generated = await this.synthesizeCompilationDatabase();
        if (generated) {
          vscode.window.showInformationMessage(
            `C/C++ Pro: Generated compile_commands.json from CMakeLists.txt at ${generated}`
          );
        } else {
          vscode.window.showWarningMessage('C/C++ Pro: Could not generate compile_commands.json.');
        }
        break;
      }
    }
  }

  private updateStatusBar(): void {
    if (!this.activeProject) {
      this.statusBarItem.hide();
      return;
    }

    const incCount = this.activeProject.includeDirectories.length;
    const mode = this.isUsingFileApi ? 'FileAPI' : 'Static';
    const presetLabel = this.activeConfigurePreset ? ` [${this.activeConfigurePreset.name}]` : '';

    this.statusBarItem.text = `$(tools) CMake: [${incCount} inc${incCount === 1 ? '' : 's'}]${presetLabel}`;
    this.statusBarItem.tooltip = [
      `C/C++ Pro CMake Intelligence (${mode}):`,
      `CMakeLists: ${this.activeProject.cmakeListsPath}`,
      this.activeConfigurePreset ? `Active Preset: ${this.activeConfigurePreset.name}` : '',
      `Discovered Includes: ${incCount}`,
      ...this.activeProject.includeDirectories.slice(0, 10).map((d) => `  - ${d}`),
      incCount > 10 ? `  ... and ${incCount - 10} more` : '',
      `Targets: ${this.activeProject.targets.length}`,
      'Click to open CMake Intelligence menu'
    ].filter(Boolean).join('\n');
    this.statusBarItem.show();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
