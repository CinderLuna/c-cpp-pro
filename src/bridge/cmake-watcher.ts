import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { debounce } from '../substrate/protocol-filter';

/**
 * Writes CMake compilation database to disk, creating any missing parent directories recursively.
 */
export async function writeCompilationDatabase(filePath: string, content: string | object): Promise<string> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  await fs.promises.writeFile(filePath, text, 'utf8');
  return filePath;
}

function isCompilationDatabase(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    norm.endsWith('/compile_commands.json') ||
    norm.endsWith('/compile_flags.txt') ||
    norm.endsWith('/.clangd')
  );
}

function isCmakeConfiguration(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    norm.endsWith('/cmakelists.txt') ||
    norm.endsWith('.cmake') ||
    norm.endsWith('/cmakepresets.json') ||
    norm.endsWith('/cmakeuserpresets.json') ||
    norm.includes('/.cmake/api/v1/reply/')
  );
}

export class CMakeWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | null = null;
  private disposables: vscode.Disposable[] = [];

  private debouncedReload = debounce(async (uri: vscode.Uri) => {
    try {
      if (fs.existsSync(uri.fsPath)) {
        const stats = fs.statSync(uri.fsPath);
        if (stats.size > 0) {
          console.log(`C/C++ Pro: Build database updated at ${uri.fsPath}. Reloading language server...`);
          await this.onReload();
        }
      }
    } catch (err) {
      console.warn(`C/C++ Pro: Error handling compilation database update:`, err);
    }
  }, 1500);

  constructor(
    private readonly onReload: () => Promise<void>,
    private readonly onCmakeUpdate?: (uri: vscode.Uri) => Promise<void>
  ) {
    // Watch for build artifacts and CMake configuration changes
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '{**/compile_commands.json,**/compile_flags.txt,**/.clangd,**/CMakeLists.txt,**/CMakePresets.json,**/CMakeUserPresets.json,**/.cmake/api/v1/reply/*.json}'
    );

    this.disposables.push(
      this.watcher.onDidChange(async (uri) => {
        if (isCmakeConfiguration(uri.fsPath)) {
          if (this.onCmakeUpdate) await this.onCmakeUpdate(uri);
        } else if (isCompilationDatabase(uri.fsPath)) {
          this.debouncedReload(uri);
        }
      }),
      this.watcher.onDidCreate(async (uri) => {
        if (isCmakeConfiguration(uri.fsPath)) {
          if (this.onCmakeUpdate) await this.onCmakeUpdate(uri);
        } else if (isCompilationDatabase(uri.fsPath)) {
          this.debouncedReload(uri);
        }
      }),
      this.watcher.onDidDelete(async (uri) => {
        if (isCmakeConfiguration(uri.fsPath)) {
          if (this.onCmakeUpdate) await this.onCmakeUpdate(uri);
        } else if (isCompilationDatabase(uri.fsPath)) {
          this.debouncedReload({ fsPath: '' } as any);
        }
      })
    );
  }

  public dispose(): void {
    this.debouncedReload.cancel();
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
