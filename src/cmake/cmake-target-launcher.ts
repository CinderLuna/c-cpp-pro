import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DebugLaunchConfiguration } from '../debugger/launch-generator';

export interface CMakeExecutableTarget {
  name: string;
  binaryPath: string;
  workingDirectory?: string;
}

export class CMakeTargetLauncher implements vscode.Disposable {
  private activeTarget: CMakeExecutableTarget | null = null;
  private knownTargets: CMakeExecutableTarget[] = [];
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      65
    );
    this.statusBarItem.command = 'c-cpp-pro.cmake.selectLaunchTarget';
    this.disposables.push(this.statusBarItem);
  }

  public setExecutableTargets(targets: CMakeExecutableTarget[]): void {
    this.knownTargets = targets;
    if (targets.length === 0) {
      this.activeTarget = null;
      this.statusBarItem.hide();
      return;
    }

    // Keep active target if it still exists in the refreshed list
    const currentName = this.activeTarget?.name;
    const matched = targets.find((t) => t.name === currentName);
    this.activeTarget = matched || targets[0];
    this.updateStatusBar();
  }

  public getActiveTarget(): CMakeExecutableTarget | null {
    return this.activeTarget;
  }

  public getKnownTargets(): CMakeExecutableTarget[] {
    return this.knownTargets;
  }

  public async selectLaunchTarget(): Promise<CMakeExecutableTarget | null> {
    if (this.knownTargets.length === 0) {
      vscode.window.showInformationMessage('No executable targets discovered in CMake project.');
      return null;
    }

    const items = this.knownTargets.map((t) => ({
      label: `$(debug-start) ${t.name}`,
      description: path.basename(t.binaryPath),
      detail: t.binaryPath,
      target: t
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select active CMake launch/debug target'
    });

    if (!selected) return null;

    this.activeTarget = selected.target;
    this.updateStatusBar();
    vscode.window.showInformationMessage(`Active CMake target set to: ${this.activeTarget.name}`);
    return this.activeTarget;
  }

  /**
   * Starts a debugging session for the active target using C/C++ Pro's DAP engine.
   */
  public async debugTarget(): Promise<boolean> {
    const target = this.activeTarget;
    if (!target) {
      vscode.window.showErrorMessage('No active CMake target selected for debugging.');
      return false;
    }

    if (!fs.existsSync(target.binaryPath)) {
      vscode.window.showWarningMessage(
        `Target executable not found at ${target.binaryPath}. Please build the project first.`
      );
      return false;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    const cwd = target.workingDirectory || folder?.uri.fsPath || path.dirname(target.binaryPath);

    const config: DebugLaunchConfiguration = {
      name: `Debug CMake Target: ${target.name}`,
      type: 'c-cpp-pro-debug',
      request: 'launch',
      program: target.binaryPath,
      args: [],
      stopAtEntry: false,
      cwd: cwd,
      environment: []
    };

    return await vscode.debug.startDebugging(folder, config);
  }

  /**
   * Executes the active target in an integrated terminal without attaching a debugger.
   */
  public launchTarget(): void {
    const target = this.activeTarget;
    if (!target) {
      vscode.window.showErrorMessage('No active CMake target selected to run.');
      return;
    }

    if (!fs.existsSync(target.binaryPath)) {
      vscode.window.showWarningMessage(
        `Target executable not found at ${target.binaryPath}. Please build the project first.`
      );
      return;
    }

    const term = vscode.window.createTerminal(`Run: ${target.name}`);
    term.show();

    const cwd = target.workingDirectory || path.dirname(target.binaryPath);
    if (process.platform === 'win32') {
      term.sendText(`cd /d "${cwd}"`);
      term.sendText(`"${target.binaryPath}"`);
    } else {
      term.sendText(`cd "${cwd}" && "${target.binaryPath}"`);
    }
  }

  private updateStatusBar(): void {
    if (!this.activeTarget) {
      this.statusBarItem.hide();
      return;
    }

    this.statusBarItem.text = `$(play) Target: ${this.activeTarget.name}`;
    this.statusBarItem.tooltip = [
      `Active CMake Target: ${this.activeTarget.name}`,
      `Binary: ${this.activeTarget.binaryPath}`,
      'Click to select different CMake target'
    ].join('\n');
    this.statusBarItem.show();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
