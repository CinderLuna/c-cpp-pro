import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { CMakeManager } from '../cmake/cmake-manager';
import { SolutionManager } from '../solution/solution-manager';
import { StreamingProblemMatcher } from '../diagnostics/problem-matcher';
import { CMakeDetector } from '../cmake/cmake-detector';

export class ProjectBuildController implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private problemMatcher: StreamingProblemMatcher;
  private disposables: vscode.Disposable[] = [];
  private isBuilding = false;

  constructor(
    private readonly cmakeManager: CMakeManager | null,
    private readonly solutionManager: SolutionManager | null
  ) {
    this.outputChannel = vscode.window.createOutputChannel('C/C++ Pro: Project Build');
    this.problemMatcher = new StreamingProblemMatcher('c-cpp-pro-project-build');
    this.disposables.push(this.outputChannel, this.problemMatcher);
  }

  public getProblemMatcher(): StreamingProblemMatcher {
    return this.problemMatcher;
  }

  /**
   * Builds the current workspace project (CMake or Visual Studio Solution).
   */
  public async buildProject(explicitRoot?: string): Promise<boolean> {
    if (this.isBuilding) {
      vscode.window.showWarningMessage('A build is already in progress.');
      return false;
    }

    const editor = vscode.window.activeTextEditor;
    const folder = explicitRoot
      ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(explicitRoot))
      : (editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : vscode.workspace.workspaceFolders?.[0]);

    const workspaceRoot = explicitRoot || folder?.uri.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspaceRoot) {
      vscode.window.showErrorMessage('No workspace folder open to build.');
      return false;
    }

    // 1. Check for CMake project
    if (CMakeDetector.isCMakeWorkspace(workspaceRoot)) {
      return await this.buildCMakeProject(workspaceRoot);
    }

    // 2. Check for Visual Studio Solution
    const solution = this.solutionManager?.getActiveSolution();
    if (solution) {
      return await this.buildSolutionProject(solution.filePath, workspaceRoot);
    }

    vscode.window.showWarningMessage('No CMakeLists.txt or Visual Studio solution found in workspace.');
    return false;
  }

  /**
   * Builds the project, and upon success, launches the active executable target in terminal.
   */
  public async buildAndRunProject(explicitRoot?: string): Promise<void> {
    const success = await this.buildProject(explicitRoot);
    if (!success) return;

    if (this.cmakeManager) {
      const launcher = this.cmakeManager.getTargetLauncher();
      const target = launcher.getActiveTarget();
      if (target) {
        launcher.launchTarget();
        return;
      }
    }

    vscode.window.showInformationMessage('Build succeeded. (No active executable target configured to launch)');
  }

  /**
   * Builds the project, and upon success, starts DAP debugging on the active executable target.
   */
  public async buildAndDebugProject(explicitRoot?: string): Promise<void> {
    const success = await this.buildProject(explicitRoot);
    if (!success) return;

    if (this.cmakeManager) {
      const launcher = this.cmakeManager.getTargetLauncher();
      const target = launcher.getActiveTarget();
      if (target) {
        await launcher.debugTarget();
        return;
      }
    }

    vscode.window.showInformationMessage('Build succeeded. (No active executable target configured to debug)');
  }

  /**
   * Executes cmake --build for the active binary directory.
   */
  private async buildCMakeProject(workspaceRoot: string): Promise<boolean> {
    this.isBuilding = true;
    this.problemMatcher.clear();
    this.outputChannel.clear();
    this.outputChannel.show(true);

    const activePreset = this.cmakeManager?.getActiveConfigurePreset();
    const binDir = activePreset?.binaryDir || path.join(workspaceRoot, 'build');

    // If binary directory lacks CMakeCache.txt, run configure first
    const cmakeCache = path.join(binDir, 'CMakeCache.txt');
    if (!fs.existsSync(cmakeCache)) {
      this.outputChannel.appendLine(`C/C++ Pro: Configuring CMake project in ${binDir}...`);
      const configSuccess = await this.runProcess('cmake', ['-B', binDir, '-S', workspaceRoot], workspaceRoot);
      if (!configSuccess) {
        this.isBuilding = false;
        vscode.window.showErrorMessage('CMake configuration failed. Check output for details.');
        return false;
      }
    }

    this.outputChannel.appendLine(`C/C++ Pro: Building CMake project (${binDir})...`);
    this.outputChannel.appendLine('---------------------------------------------------');

    const startTime = Date.now();
    const buildSuccess = await this.runProcess('cmake', ['--build', binDir], workspaceRoot);
    const duration = Date.now() - startTime;

    this.outputChannel.appendLine('---------------------------------------------------');
    if (buildSuccess) {
      this.outputChannel.appendLine(`Build finished successfully in ${duration}ms.`);
      vscode.window.setStatusBarMessage(`C/C++ Pro: Build Succeeded (${duration}ms)`, 4000);
      // Refresh CMake state after build
      await this.cmakeManager?.refresh();
    } else {
      this.outputChannel.appendLine(`Build failed (${duration}ms). Check Problems tab.`);
      vscode.window.showErrorMessage(`Build failed (${duration}ms). Check Problems tab for errors.`);
    }

    this.isBuilding = false;
    return buildSuccess;
  }

  /**
   * Executes MSBuild for the given solution file.
   */
  private async buildSolutionProject(solutionPath: string, workspaceRoot: string): Promise<boolean> {
    this.isBuilding = true;
    this.problemMatcher.clear();
    this.outputChannel.clear();
    this.outputChannel.show(true);

    this.outputChannel.appendLine(`C/C++ Pro: Building solution ${path.basename(solutionPath)}...`);
    this.outputChannel.appendLine('---------------------------------------------------');

    const startTime = Date.now();
    const msbuild = 'msbuild';
    const buildSuccess = await this.runProcess(
      msbuild,
      [solutionPath, '/p:Configuration=Debug', '/p:Platform=x64', '/m'],
      workspaceRoot
    );
    const duration = Date.now() - startTime;

    this.outputChannel.appendLine('---------------------------------------------------');
    if (buildSuccess) {
      this.outputChannel.appendLine(`Build finished successfully in ${duration}ms.`);
      vscode.window.setStatusBarMessage(`C/C++ Pro: Solution Build Succeeded (${duration}ms)`, 4000);
    } else {
      this.outputChannel.appendLine(`Solution build failed (${duration}ms).`);
      vscode.window.showErrorMessage(`Solution build failed (${duration}ms). Check Problems tab.`);
    }

    this.isBuilding = false;
    return buildSuccess;
  }

  private runProcess(cmd: string, args: string[], cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, {
          cwd,
          windowsHide: true,
          shell: process.platform === 'win32'
        });
      } catch (err: any) {
        this.outputChannel.appendLine(`Failed to spawn ${cmd}: ${err.message}`);
        resolve(false);
        return;
      }

      const handleOutput = (data: Buffer) => {
        const text = data.toString('utf8');
        this.outputChannel.append(text);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          this.problemMatcher.ingestLine(line, cwd);
        }
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);

      let settled = false;
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        resolve(code === 0);
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        this.outputChannel.appendLine(`Process error: ${err.message}`);
        resolve(false);
      });
    });
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
