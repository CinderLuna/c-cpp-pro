import * as vscode from 'vscode';
import * as os from 'os';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  RequestType,
  NotificationType,
  TextDocumentIdentifier,
  State,
  CloseAction,
  ErrorAction
} from 'vscode-languageclient/node';
import { ClangdInstaller } from './installer';
import { createClangdMiddleware, debounce } from './protocol-filter';
import { StlRankingTable } from '../telemetry/ranking-table';
import { ExternalSdkDetector } from '../prober/external-sdk-detector';
import { CMakeParser } from '../cmake/cmake-parser';

export const defaultClangdArguments: string[] = [
  '--background-index',
  '--clang-tidy',
  '--header-insertion=iwyu',
  '--completion-style=detailed',
  '--function-arg-placeholders=true',
  '--fallback-style=llvm',
  '--header-insertion-decorators=true',
  '-j=0',
  '--offset-encoding=utf-16'
];

export interface InactiveRegionsParams {
  textDocument: TextDocumentIdentifier;
  regions: vscode.Range[];
}

export const SwitchSourceHeaderRequest = new RequestType<
  TextDocumentIdentifier,
  string | null,
  void
>('textDocument/switchSourceHeader');

export const InactiveRegionsNotification = new NotificationType<InactiveRegionsParams>(
  'textDocument/inactiveRegions'
);

export class DaemonManager implements vscode.Disposable {
  private client: LanguageClient | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private outputChannel: vscode.LogOutputChannel;
  private disposables: vscode.Disposable[] = [];
  private clientDisposables: vscode.Disposable[] = [];
  private onInactiveRegionsEmitter = new vscode.EventEmitter<InactiveRegionsParams>();
  public readonly onInactiveRegions = this.onInactiveRegionsEmitter.event;

  private crashCount = 0;
  private maxRestarts = 5;
  private lastRestartTime = 0;
  private stabilityTimeout: NodeJS.Timeout | null = null;
  private crashRestartTimeout: NodeJS.Timeout | null = null;
  private isStopping = false;
  private isRestarting = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restartPromise: Promise<void> | null = null;
  private activeWatchers: vscode.FileSystemWatcher[] = [];

  public debouncedStart = debounce(async () => {
    await this.start();
  }, 300);

  constructor(
    _context: vscode.ExtensionContext,
    private readonly installer: ClangdInstaller,
    private readonly rankingTable: StlRankingTable = new StlRankingTable()
  ) {
    this.outputChannel = vscode.window.createOutputChannel('C/C++ Pro Language Server', { log: true });
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = 'C/C++ Pro Status';
    this.statusBarItem.command = 'c-cpp-pro.restartServer';

    this.disposables.push(
      this.outputChannel,
      this.statusBarItem,
      this.onInactiveRegionsEmitter
    );
  }

  private cancelPendingStarts(): void {
    if (this.crashRestartTimeout) {
      clearTimeout(this.crashRestartTimeout);
      this.crashRestartTimeout = null;
    }
    if (this.stabilityTimeout) {
      clearTimeout(this.stabilityTimeout);
      this.stabilityTimeout = null;
    }
    this.debouncedStart.cancel();
  }

  private async runSerialized<T>(action: () => Promise<T>): Promise<T> {
    const execute = async () => {
      return await action();
    };
    const resultPromise = this.lifecycleQueue.then(execute, execute);
    this.lifecycleQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }

  public async start(): Promise<void> {
    if (this.client && this.client.isRunning()) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.runSerialized(async () => {
      try {
        if (this.client && this.client.isRunning()) {
          return;
        }
        await this.doStart();
      } finally {
        this.startPromise = null;
      }
    });

    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.updateStatusBar('$(sync~spin) C/C++ Pro: Resolving clangd...', 'Searching for clangd binary');
    this.statusBarItem.show();

    const clangdPath = await this.installer.resolveClangdPath();
    if (!clangdPath) {
      this.updateStatusBar('$(error) C/C++ Pro: clangd missing', 'Click to install clangd');
      this.statusBarItem.command = 'c-cpp-pro.installClangd';
      const action = await vscode.window.showErrorMessage(
        'C/C++ Pro: clangd executable not found. Would you like to install it now?',
        'Install clangd',
        'Configure Path'
      );
      if (action === 'Install clangd') {
        await vscode.commands.executeCommand('c-cpp-pro.installClangd');
      } else if (action === 'Configure Path') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'c-cpp-pro.clangdPath');
      }
      return;
    }

    this.updateStatusBar('$(sync~spin) C/C++ Pro: Starting...', `Launching ${clangdPath}`);

    const config = vscode.workspace.getConfiguration('c-cpp-pro');
    const userArgs = config.get<string[]>('clangdArgs') ?? [];

    // Combine default and user arguments uniquely
    const argSet = new Set<string>(defaultClangdArguments);
    for (const arg of userArgs) {
      argSet.add(arg);
    }

    // Sanitize arguments: Clangd rejects -j=0 with "A number of worker threads cannot be 0"
    // Worker threads must be >= 1. Map 0 to all available hardware CPU cores.
    const finalArgs = Array.from(argSet).map((arg) => {
      if (arg === '-j=0' || arg === '-j 0') {
        const cores = Math.max(1, os.cpus()?.length || 4);
        return `-j=${cores}`;
      }
      return arg;
    });

    // Ensure --offset-encoding=utf-16 is present. Clangd defaults to utf-8, but vscode-languageclient v9
    // strictly expects UTF-16 position encoding and will reject initialization with:
    // "Unsupported position encoding (utf-8) received from server C/C++ Pro Language Server"
    if (!finalArgs.some((arg) => arg.startsWith('--offset-encoding'))) {
      finalArgs.push('--offset-encoding=utf-16');
    }

    const serverOptions: ServerOptions = {
      command: clangdPath,
      args: finalArgs,
      options: {
        env: process.env
      }
    };

    const detectExternalSdks = config.get<boolean>('discovery.detectExternalSdks', true);
    const fallbackFlags = ['-std=c++20', '-xc++'];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      for (const folder of workspaceFolders) {
        // Parse and include CMake include directories
        const cmakeIncludes = CMakeParser.getIncludePaths(folder.uri.fsPath);
        for (const inc of cmakeIncludes) {
          const flag = `-I${inc.replace(/\\/g, '/')}`;
          if (!fallbackFlags.includes(flag)) {
            fallbackFlags.push(flag);
          }
        }

        if (detectExternalSdks) {
          const qtToolchain = config.get<string>('discovery.qtToolchain', '');
          const sdkOpts = {
            workspaceRoot: folder.uri.fsPath,
            preferredToolchain: qtToolchain.trim() ? qtToolchain.trim() : undefined
          };
          const sdkIncludes = ExternalSdkDetector.getWorkspaceIncludePaths(folder.uri.fsPath, sdkOpts);
          for (const inc of sdkIncludes) {
            const flag = `-I${inc.replace(/\\/g, '/')}`;
            if (!fallbackFlags.includes(flag)) {
              fallbackFlags.push(flag);
            }
          }
          ExternalSdkDetector.syncWorkspaceClangdConfig(folder.uri.fsPath, sdkOpts);
        }
      }
    }

    this.activeWatchers = [
      vscode.workspace.createFileSystemWatcher('**/compile_commands.json'),
      vscode.workspace.createFileSystemWatcher('**/compile_flags.txt'),
      vscode.workspace.createFileSystemWatcher('**/.clangd')
    ];

    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { scheme: 'file', language: 'c' },
        { scheme: 'file', language: 'cpp' },
        { scheme: 'file', language: 'cuda-cpp' }
      ],
      synchronize: {
        fileEvents: this.activeWatchers
      },
      initializationOptions: {
        clangdFileStatus: true,
        fallbackFlags,
        offsetEncoding: ['utf-16']
      },
      initializationFailedHandler: (error: any) => {
        this.outputChannel.appendLine(`[Initialization Failed] ${error?.message ?? error}`);
        return false;
      },
      outputChannel: this.outputChannel,
      middleware: createClangdMiddleware(this.rankingTable),
      errorHandler: {
        error: (error, _message, count) => {
          this.outputChannel.appendLine(`[Error] ${error.message} (${count})`);
          return { action: ErrorAction.Continue, handled: true };
        },
        closed: () => {
          this.outputChannel.appendLine('[Closed] Connection to clangd closed.');
          if (this.stabilityTimeout) {
            clearTimeout(this.stabilityTimeout);
            this.stabilityTimeout = null;
          }
          if (this.isStopping) {
            return { action: CloseAction.DoNotRestart, handled: true };
          }
          const now = Date.now();
          if (now - this.lastRestartTime > 60000) {
            this.crashCount = 0;
          }
          this.lastRestartTime = now;

          if (this.crashCount < this.maxRestarts) {
            const delay = Math.min(1000 * Math.pow(2, this.crashCount), 10000);
            this.crashCount++;
            this.outputChannel.appendLine(
              `[Watchdog] Attempting auto-restart (${this.crashCount}/${this.maxRestarts}) after ${delay}ms backoff...`
            );
            if (this.crashRestartTimeout) {
              clearTimeout(this.crashRestartTimeout);
            }
            this.crashRestartTimeout = setTimeout(() => {
              this.crashRestartTimeout = null;
              this.restart();
            }, delay);
            return { action: CloseAction.DoNotRestart, handled: true };
          } else {
            this.crashCount++;
            vscode.window.showErrorMessage(
              'C/C++ Pro: clangd daemon crashed repeatedly. Auto-restart aborted.'
            );
            this.updateStatusBar('$(error) C/C++ Pro: Crashed', 'Click to restart language server');
            return { action: CloseAction.DoNotRestart, handled: true };
          }
        }
      }
    };

    this.client = new LanguageClient(
      'c-cpp-pro.clangd',
      'C/C++ Pro Language Server',
      serverOptions,
      clientOptions
    );

    this.clientDisposables.push(
      this.client.onDidChangeState((event) => {
        if (event.newState === State.Running) {
          this.updateStatusBar('$(check) C/C++ Pro: Ready', 'clangd is active and ready');
          this.registerCustomProtocolHandlers();
          if (this.stabilityTimeout) {
            clearTimeout(this.stabilityTimeout);
          }
          this.stabilityTimeout = setTimeout(() => {
            this.crashCount = 0;
            this.stabilityTimeout = null;
          }, 60000);
        } else if (event.newState === State.Stopped) {
          if (this.stabilityTimeout) {
            clearTimeout(this.stabilityTimeout);
            this.stabilityTimeout = null;
          }
          this.updateStatusBar('$(circle-slash) C/C++ Pro: Stopped', 'Click to start language server');
        }
      })
    );

    try {
      await this.client.start();
      this.outputChannel.appendLine(`[Info] clangd daemon started successfully from ${clangdPath}`);
    } catch (err: any) {
      this.outputChannel.appendLine(`[Fatal] Failed to start clangd: ${err.message ?? err}`);
      this.updateStatusBar('$(error) C/C++ Pro: Launch Failed', 'Click to inspect logs');
      vscode.window.showErrorMessage(`C/C++ Pro: Failed to start clangd: ${err.message ?? err}`);
    }
  }

  private registerCustomProtocolHandlers(): void {
    if (!this.client) return;

    // Listen to inactive regions notification for dead code dimming
    this.client.onNotification(InactiveRegionsNotification, (params: InactiveRegionsParams) => {
      this.onInactiveRegionsEmitter.fire(params);
    });

    // Listen to clangd file status for status bar index progress
    this.client.onNotification(
      'textDocument/clangd.fileStatus',
      (status: { uri: string; state: string }) => {
        if (status.state.includes('idle')) {
          this.updateStatusBar('$(check) C/C++ Pro: Idle', `Idle on ${status.uri}`);
        } else {
          this.updateStatusBar(`$(sync~spin) C/C++ Pro: ${status.state}`, status.state);
        }
      }
    );
  }

  public async switchSourceHeader(): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || !this.client || !this.client.isRunning()) {
      vscode.window.showWarningMessage('C/C++ Pro: No active C/C++ file or clangd is not running');
      return;
    }

    const docId: TextDocumentIdentifier = {
      uri: activeEditor.document.uri.toString()
    };

    try {
      const targetUriString = await this.client.sendRequest(SwitchSourceHeaderRequest, docId);
      if (targetUriString) {
        const targetUri = vscode.Uri.parse(targetUriString);
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { preview: false });
      } else {
        vscode.window.showInformationMessage('C/C++ Pro: Corresponding source/header not found');
      }
    } catch (err: any) {
      vscode.window.showErrorMessage(`C/C++ Pro: Failed to switch source/header: ${err.message ?? err}`);
    }
  }

  public async restart(): Promise<void> {
    this.cancelPendingStarts();
    if (this.isRestarting && this.restartPromise) {
      return this.restartPromise;
    }
    this.isRestarting = true;

    this.restartPromise = this.runSerialized(async () => {
      try {
        this.outputChannel.appendLine('[Info] Restarting C/C++ Pro Language Server...');
        await this.doStop();
        await this.doStart();
      } finally {
        this.isRestarting = false;
        this.restartPromise = null;
      }
    });

    return this.restartPromise;
  }

  public async stop(): Promise<void> {
    this.cancelPendingStarts();
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.runSerialized(async () => {
      try {
        await this.doStop();
      } finally {
        this.stopPromise = null;
      }
    });

    return this.stopPromise;
  }

  private async doStop(): Promise<void> {
    this.isStopping = true;
    try {
      for (const watcher of this.activeWatchers) {
        try {
          watcher.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
      this.activeWatchers = [];

      for (const d of this.clientDisposables) {
        d.dispose();
      }
      this.clientDisposables = [];

      if (this.client) {
        const clientToStop = this.client;
        this.client = null;
        try {
          if (clientToStop.isRunning()) {
            await clientToStop.stop();
          } else {
            await clientToStop.dispose();
          }
        } catch (err) {
          this.outputChannel.appendLine(`[Warn] Error stopping client: ${err}`);
        }
      }
    } finally {
      this.isStopping = false;
    }
  }

  private updateStatusBar(text: string, tooltip: string): void {
    this.statusBarItem.text = text;
    this.statusBarItem.tooltip = tooltip;
    this.statusBarItem.command = 'c-cpp-pro.restartServer';
  }

  public getClient(): LanguageClient | null {
    return this.client;
  }

  dispose(): void {
    this.cancelPendingStarts();
    this.stop().catch(() => {});
    for (const watcher of this.activeWatchers) {
      try {
        watcher.dispose();
      } catch {
        // Ignore disposal errors
      }
    }
    this.activeWatchers = [];
    for (const d of this.clientDisposables) {
      d.dispose();
    }
    this.clientDisposables = [];
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
