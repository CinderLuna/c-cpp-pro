import * as assert from 'assert';
import * as vscode from 'vscode';
import { registerAllCommands, CommandRegistryContext } from '../src/commands/command-registry';
import { makeFindReferencesLink } from '../src/intelligence/command-links';

describe('Find References Integration & Command', () => {
  let disposables: vscode.Disposable[] = [];
  let executedCommands: { command: string; args: unknown[] }[] = [];

  beforeEach(() => {
    executedCommands = [];
    const origExecute = vscode.commands.executeCommand;
    (vscode.commands as unknown as { executeCommand: (cmd: string, ...args: unknown[]) => Promise<unknown> }).executeCommand =
      async (cmd: string, ...args: unknown[]) => {
        executedCommands.push({ command: cmd, args });
        return origExecute(cmd, ...args);
      };

    const dummyCtx: CommandRegistryContext = {
      extensionContext: {
        extensionUri: vscode.Uri.file('/ext'),
        subscriptions: []
      } as unknown as vscode.ExtensionContext,
      daemonManager: null,
      installer: null,
      detector: null,
      extractor: null,
      synthesizer: null,
      runController: null,
      stlCollector: null,
      batchDispatcher: null,
      solutionManager: null,
      profileManager: null,
      cmakeManager: null,
      projectBuildController: null,
      memoryLayoutInspector: {} as any,
      includeVisualizer: {} as any,
      testController: {} as any,
      macroEvaluator: {} as any,
      disasmProvider: {} as any,
      hierarchyManager: {} as any,
      getTelemetryOutputChannel: () => ({ appendLine: () => {} } as any)
    };

    disposables = registerAllCommands(dummyCtx);
  });

  afterEach(() => {
    for (const d of disposables) {
      d.dispose();
    }
    disposables = [];
  });

  it('makeFindReferencesLink should generate fallback link when no position is passed', () => {
    const link = makeFindReferencesLink();
    assert.strictEqual(link, '[Find References](command:c-cpp-pro.findReferences)');
  });

  it('makeFindReferencesLink should generate URI-encoded parameter link when document and position are passed', () => {
    const uri = vscode.Uri.file('/workspace/src/main.cpp');
    const pos = new vscode.Position(15, 8);
    const link = makeFindReferencesLink(uri, pos);
    const expectedQuery = encodeURIComponent(JSON.stringify([uri.toString(), 15, 8]));
    assert.strictEqual(link, `[Find References](command:c-cpp-pro.findReferences?${expectedQuery})`);
  });

  it('should navigate to document position and trigger editor.action.findReferences when invoked with individual arguments', async () => {
    const uriStr = 'file:///workspace/src/widget.cpp';
    await vscode.commands.executeCommand('c-cpp-pro.findReferences', uriStr, 25, 4);

    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.selection.active.line, 25);
    assert.strictEqual(activeEditor.selection.active.character, 4);

    const findRefsTriggered = executedCommands.some((c) => c.command === 'editor.action.findReferences');
    assert.ok(findRefsTriggered);
  });

  it('should navigate to document position and trigger references when invoked with JSON-decoded array', async () => {
    const uriStr = 'file:///workspace/src/model.cpp';
    await vscode.commands.executeCommand('c-cpp-pro.findReferences', [uriStr, 10, 12]);

    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.selection.active.line, 10);
    assert.strictEqual(activeEditor.selection.active.character, 12);

    const findRefsTriggered = executedCommands.some((c) => c.command === 'editor.action.findReferences');
    assert.ok(findRefsTriggered);
  });

  it('should navigate to document position and trigger references when invoked with object payload', async () => {
    const uri = vscode.Uri.file('/workspace/src/view.cpp');
    await vscode.commands.executeCommand('c-cpp-pro.findReferences', {
      uri: uri.toString(),
      position: { line: 5, character: 2 }
    });

    const activeEditor = vscode.window.activeTextEditor;
    assert.ok(activeEditor);
    assert.strictEqual(activeEditor.selection.active.line, 5);
    assert.strictEqual(activeEditor.selection.active.character, 2);

    const findRefsTriggered = executedCommands.some((c) => c.command === 'editor.action.findReferences');
    assert.ok(findRefsTriggered);
  });

  it('should fallback to active editor when invoked without arguments', async () => {
    executedCommands = [];
    await vscode.commands.executeCommand('c-cpp-pro.findReferences');

    const findRefsTriggered = executedCommands.some((c) => c.command === 'editor.action.findReferences');
    assert.ok(findRefsTriggered);
  });
});
