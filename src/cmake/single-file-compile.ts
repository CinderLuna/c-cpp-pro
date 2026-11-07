import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { StreamingProblemMatcher } from '../diagnostics/problem-matcher';

export class SingleFileCompiler implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;
  private problemMatcher: StreamingProblemMatcher;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('C/C++ Pro: Single File Compile');
    this.problemMatcher = new StreamingProblemMatcher('c-cpp-pro-single-compile');
    this.disposables.push(this.outputChannel, this.problemMatcher);
  }

  /**
   * Compiles the active editor source file directly to verify syntax and generate diagnostics.
   */
  public async compileActiveFile(activeFilePath?: string): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    const targetFile = activeFilePath || editor?.document.fileName;

    if (!targetFile) {
      vscode.window.showInformationMessage('No active C/C++ file to compile.');
      return false;
    }

    const ext = path.extname(targetFile).toLowerCase();
    if (!['.c', '.cpp', '.cxx', '.cc', '.cu'].includes(ext)) {
      vscode.window.showWarningMessage('Active file is not a C/C++ source file.');
      return false;
    }

    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(targetFile));
    const workspaceRoot = folder?.uri.fsPath || path.dirname(targetFile);

    // 1. Locate compile_commands.json
    const compDbCandidates = [
      path.join(workspaceRoot, 'compile_commands.json'),
      path.join(workspaceRoot, 'build', 'compile_commands.json'),
      path.join(workspaceRoot, 'out', 'compile_commands.json')
    ];

    let compileEntry: { directory?: string; command?: string; arguments?: string[]; file?: string } | null = null;
    const targetNorm = targetFile.replace(/\\/g, '/').toLowerCase();

    for (const compDb of compDbCandidates) {
      if (fs.existsSync(compDb)) {
        try {
          const content = fs.readFileSync(compDb, 'utf8');
          const entries = JSON.parse(content);
          if (Array.isArray(entries)) {
            const found = entries.find(
              (e) => e.file && e.file.replace(/\\/g, '/').toLowerCase() === targetNorm
            );
            if (found) {
              compileEntry = found;
              break;
            }
          }
        } catch {
          // Ignore read error
        }
      }
    }

    let bin = 'clang++';
    let args: string[] = ['-fsyntax-only', targetFile];
    let cwd = workspaceRoot;

    if (compileEntry) {
      cwd = compileEntry.directory || workspaceRoot;
      if (compileEntry.arguments && compileEntry.arguments.length > 0) {
        bin = compileEntry.arguments[0];
        args = compileEntry.arguments.slice(1);
      } else if (compileEntry.command) {
        const parts = compileEntry.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        const cleanParts = parts.map((p) => p.replace(/^["']|["']$/g, ''));
        if (cleanParts.length > 0) {
          bin = cleanParts[0];
          args = cleanParts.slice(1);
        }
      }

      // Convert full compile/link command into syntax check / compile-only
      const isCl = bin.toLowerCase().includes('cl.exe') || bin.toLowerCase() === 'cl';
      if (isCl) {
        // MSVC: replace output flags or add /Zs (syntax check only)
        args = args.filter((a) => !/^\/(?:Fo|Fe|Fd|link)/i.test(a));
        if (!args.includes('/c') && !args.includes('/Zs')) {
          args.push('/Zs');
        }
      } else {
        // GCC/Clang: replace -o or add -fsyntax-only
        const cleaned: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '-o') {
            i++; // Skip output argument
          } else if (!args[i].startsWith('-o')) {
            cleaned.push(args[i]);
          }
        }
        if (!cleaned.includes('-c') && !cleaned.includes('-fsyntax-only')) {
          cleaned.push('-fsyntax-only');
        }
        args = cleaned;
      }
    }

    this.problemMatcher.clear();
    this.outputChannel.clear();
    this.outputChannel.show(true);
    this.outputChannel.appendLine(`C/C++ Pro: Compiling ${path.basename(targetFile)}...`);
    this.outputChannel.appendLine(`Command: ${bin} ${args.join(' ')}`);
    this.outputChannel.appendLine(`Directory: ${cwd}`);
    this.outputChannel.appendLine('---------------------------------------------------');

    const startTime = Date.now();

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, args, {
          cwd,
          windowsHide: true,
          shell: false
        });
      } catch (err: any) {
        this.outputChannel.appendLine(`Execution failed: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to spawn compiler: ${err.message}`);
        resolve(false);
        return;
      }

      const handleOutput = (data: Buffer) => {
        const text = data.toString('utf8');
        this.outputChannel.append(text);
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          this.problemMatcher.ingestLine(line, workspaceRoot);
        }
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);

      child.on('close', (code) => {
        const duration = Date.now() - startTime;
        this.outputChannel.appendLine('---------------------------------------------------');
        if (code === 0) {
          this.outputChannel.appendLine(`Compilation succeeded in ${duration}ms with 0 errors.`);
          vscode.window.setStatusBarMessage(
            `C/C++ Pro: Compiled ${path.basename(targetFile)} (${duration}ms)`,
            4000
          );
          resolve(true);
        } else {
          this.outputChannel.appendLine(`Compilation failed with exit code ${code} (${duration}ms).`);
          vscode.window.showErrorMessage(
            `Compilation failed for ${path.basename(targetFile)} (exit code ${code}). Check Problems tab.`
          );
          resolve(false);
        }
      });

      child.on('error', (err) => {
        this.outputChannel.appendLine(`Spawn error: ${err.message}`);
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
