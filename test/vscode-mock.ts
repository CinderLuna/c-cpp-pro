/* eslint-disable @typescript-eslint/no-explicit-any */
import Module from 'module';

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
  compareTo(other: Position): number {
    if (this.line !== other.line) return this.line - other.line;
    return this.character - other.character;
  }
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;
  constructor(startOrStartLine: Position | number, endOrStartChar: Position | number, endLine?: number, endChar?: number) {
    if (typeof startOrStartLine === 'number') {
      this.start = new Position(startOrStartLine, endOrStartChar as number);
      this.end = new Position(endLine as number, endChar as number);
    } else {
      this.start = startOrStartLine;
      this.end = endOrStartChar as Position;
    }
  }
}

export class Selection extends Range {
  public readonly anchor: Position;
  public readonly active: Position;
  constructor(anchor: Position, active: Position) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

export class Location {
  public range: Range;
  constructor(public uri: any, rangeOrPosition: Range | Position) {
    if (rangeOrPosition instanceof Position) {
      this.range = new Range(rangeOrPosition, rangeOrPosition);
    } else {
      this.range = rangeOrPosition;
    }
  }
}

export class CodeLens {
  constructor(public range: Range, public command?: any) {}
}

export class DocumentLink {
  constructor(public range: Range, public target?: any) {}
}

export class CodeAction {
  public edit?: any;
  public diagnostics?: any[];
  public command?: any;
  public isPreferred?: boolean;
  public kind?: any;
  constructor(public title: string, public actionKind?: any) {
    this.kind = actionKind;
  }
}

export class DocumentSymbol {
  public children: DocumentSymbol[] = [];
  constructor(
    public name: string,
    public detail: string,
    public kind: number,
    public range: Range,
    public selectionRange: Range
  ) {}
}

export class Diagnostic {
  public code?: string | number;
  public source?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity: number = 0
  ) {}
}

export class InlayHint {
  constructor(public position: Position, public label: string | any[], public kind?: any) {}
}

export class EvaluatableExpression {
  constructor(public readonly range: Range, public readonly expression?: string) {}
}

export class CallHierarchyItem {
  constructor(
    public kind: number,
    public name: string,
    public detail: string,
    public uri: any,
    public range: Range,
    public selectionRange: Range
  ) {}
}

export class TypeHierarchyItem {
  constructor(
    public kind: number,
    public name: string,
    public detail: string,
    public uri: any,
    public range: Range,
    public selectionRange: Range
  ) {}
}

export class SnippetString {
  constructor(public value: string = '') {}
}

export class CompletionItem {
  public filterText?: string;
  public commitCharacters?: string[];
  public command?: { title: string; command: string };
  public range?: Range | { inserting: Range; replacing: Range };
  constructor(public label: string | { label: string }, public kind?: any) {}
}

export class CompletionList {
  constructor(public items: any[] = [], public isIncomplete: boolean = false) {}
}

export class SymbolInformation {
  constructor(
    public name: string,
    public kind: any,
    public containerName: string,
    public location: any
  ) {}
}

export class MarkdownString {
  public isTrusted: boolean = false;
  public supportThemeIcons: boolean = false;
  constructor(public value: string = '') {}
  appendMarkdown(val: string): MarkdownString {
    this.value += val;
    return this;
  }
  appendCodeblock(val: string, language: string = ''): MarkdownString {
    this.value += `\n\`\`\`${language}\n${val}\n\`\`\`\n`;
    return this;
  }
  appendText(val: string): MarkdownString {
    this.value += val;
    return this;
  }
}

export class Hover {
  public contents: any[];
  constructor(contents: any, public range?: Range) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }
}

export class SignatureHelp {
  public signatures: any[] = [];
  public activeSignature: number = 0;
  public activeParameter: number = 0;
}

export class SignatureInformation {
  constructor(public label: string, public documentation?: any) {}
}

export class ParameterInformation {
  constructor(public label: string | [number, number], public documentation?: any) {}
}

export class TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText);
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, '');
  }
  constructor(public range: Range, public newText: string) {}
}

export class SnippetTextEdit {
  static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(range, snippet);
  }
  static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
  constructor(public range: Range, public snippet: SnippetString) {}
}

export class WorkspaceEdit {
  private changes = new Map<string, any[]>();
  insert(uri: any, position: Position, newText: string): void {
    const key = uri.toString ? uri.toString() : String(uri);
    const list = this.changes.get(key) || [];
    list.push(TextEdit.insert(position, newText));
    this.changes.set(key, list);
  }
  replace(uri: any, range: Range, newText: string): void {
    const key = uri.toString ? uri.toString() : String(uri);
    const list = this.changes.get(key) || [];
    list.push(TextEdit.replace(range, newText));
    this.changes.set(key, list);
  }
  delete(uri: any, range: Range): void {
    const key = uri.toString ? uri.toString() : String(uri);
    const list = this.changes.get(key) || [];
    list.push(TextEdit.delete(range));
    this.changes.set(key, list);
  }
  set(uri: any, edits: any[]): void {
    const key = uri.toString ? uri.toString() : String(uri);
    this.changes.set(key, edits);
  }
  get(uri: any): any[] | undefined {
    const key = uri.toString ? uri.toString() : String(uri);
    return this.changes.get(key);
  }
}

export class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CancellationError';
  }
}

export class FileSystemError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'FileSystemError';
  }
}

export enum DecorationRangeBehavior {
  OpenBottomRight = 0,
  OpenOpen = 1,
  ClosedBottomRight = 2,
  ClosedClosed = 3
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}

export class RelativePattern {
  constructor(public base: any, public pattern: string) {}
}

export class Uri {
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static parse(uriStr: string): Uri {
    let clean = uriStr;
    try {
      clean = decodeURIComponent(uriStr);
    } catch {}
    if (clean.startsWith('file://')) {
      let raw = clean.substring(7);
      if (/^\/[a-zA-Z]:/.test(raw)) {
        raw = raw.substring(1);
      } else if (!raw.startsWith('/') && process.platform !== 'win32') {
        raw = '/' + raw;
      }
      return new Uri('file', raw);
    }
    return new Uri('file', clean);
  }
  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    const p = require('path');
    return new Uri(base.scheme, p.join(base.fsPath, ...pathSegments));
  }
  constructor(public readonly scheme: string, public readonly fsPath: string) {}
  toString(): string {
    const p = this.fsPath.replace(/\\/g, '/');
    if (p.startsWith('file://')) return p;
    if (process.platform === 'win32' || /^[a-zA-Z]:/.test(p) || /^\/[a-zA-Z]:/.test(p)) {
      return `${this.scheme}:///${p.replace(/^\/+/, '')}`;
    }
    return `${this.scheme}://${p.startsWith('/') ? p : '/' + p}`;
  }
}

export class EventEmitter<T = any> {
  private listeners: ((e: T) => void)[] = [];
  public event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      }
    };
  };
  public fire(data: T): void {
    for (const l of this.listeners) {
      l(data);
    }
  }
  public dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  static from(...disposables: { dispose(): any }[]): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }
  constructor(private readonly callOnDispose: () => any) {}
  dispose(): any {
    return this.callOnDispose();
  }
}

export class DebugAdapterExecutable {
  constructor(public command: string, public args: string[] = [], public options?: any) {}
}

export class DebugAdapterServer {
  constructor(public port: number, public host?: string) {}
}

export class Task {
  constructor(
    public definition: any,
    public scope: any,
    public name: string,
    public source: string,
    public execution?: any,
    public problemMatchers?: string | string[]
  ) {}
}

export class ProcessExecution {
  constructor(public process: string, public args: string[] = [], public options?: any) {}
}

export class ShellExecution {
  constructor(public commandLine: string, public options?: any) {}
}

export enum TaskScope {
  Global = 1,
  Workspace = 2
}

export const TaskGroup = {
  Clean: { isDefault: false },
  Build: { isDefault: true },
  Rebuild: { isDefault: false },
  Test: { isDefault: false }
};

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24
}

export const CodeActionKind = {
  QuickFix: 'quickfix',
  Refactor: 'refactor',
  RefactorExtract: 'refactor.extract',
  RefactorInline: 'refactor.inline',
  RefactorRewrite: 'refactor.rewrite',
  Source: 'source',
  SourceOrganizeImports: 'source.organizeImports'
};

export const mockVscode: any = {
  Position,
  Range,
  Selection,
  Location,
  CodeLens,
  DocumentLink,
  CodeAction,
  CodeActionKind,
  DocumentSymbol,
  Diagnostic,
  DiagnosticSeverity,
  InlayHint,
  CallHierarchyItem,
  TypeHierarchyItem,
  SnippetString,
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  SymbolInformation,
  SymbolKind,
  MarkdownString,
  Hover,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  TextEdit,
  WorkspaceEdit,
  CancellationError,
  FileSystemError,
  ThemeColor,
  ThemeIcon,
  DecorationRangeBehavior,
  RelativePattern,
  ConfigurationTarget,
  DebugAdapterExecutable,
  DebugAdapterServer,
  Task,
  ProcessExecution,
  ShellExecution,
  TaskScope,
  TaskGroup,
  ProgressLocation,
  Uri,
  EventEmitter,
  Disposable,
  StatusBarAlignment,
  window: {
    createStatusBarItem: () => ({
      text: '',
      tooltip: '',
      command: '',
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),
    createOutputChannel: (name: string, _options?: any) => ({
      name,
      appendLine: () => {},
      append: () => {},
      clear: () => {},
      show: () => {},
      dispose: () => {},
      replace: () => {},
      logLevel: 1,
      onDidChangeLogLevel: () => ({ dispose: () => {} }),
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    }),
    showInformationMessage: async (msg: string, ..._items: any[]) => {
      (mockVscode.window as any).lastInformationMessage = msg;
      return undefined;
    },
    showErrorMessage: async (msg: string, ..._items: any[]) => {
      (mockVscode.window as any).lastErrorMessage = msg;
      return undefined;
    },
    showWarningMessage: async (msg: string, ..._items: any[]) => {
      (mockVscode.window as any).lastWarningMessage = msg;
      return undefined;
    },
    withProgress: async (_options: any, task: any) => {
      return task({ report: () => {} }, { onCancellationRequested: () => {} });
    },
    visibleTextEditors: [],
    terminals: [] as any[],
    createTerminal: (optionsOrName?: any, shellPath?: any, shellArgs?: any) => {
      const termName = typeof optionsOrName === 'string' ? optionsOrName : (optionsOrName?.name ?? 'Terminal');
      const term = {
        name: termName,
        options: typeof optionsOrName === 'object' ? optionsOrName : { name: optionsOrName, shellPath, shellArgs },
        sendText: (_text: string) => {},
        show: () => {},
        hide: () => {},
        dispose: () => {}
      };
      (mockVscode.window.terminals as any[]).push(term);
      return term;
    },
    onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
    onDidChangeTextEditorVisibleRanges: () => ({ dispose: () => {} }),
    onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
    createTextEditorDecorationType: (options?: any) => ({
      dispose: () => {},
      options
    }),
    createWebviewPanel: (viewType: string, title: string, _showOptions: any, _options: any) => {
      let messageListener: any = null;
      let disposeListener: any = null;
      return {
        viewType,
        title,
        webview: {
          html: '',
          asWebviewUri: (uri: any) => uri,
          postMessage: async (msg: any) => {
            if (messageListener) messageListener(msg);
          },
          onDidReceiveMessage: (listener: any) => {
            messageListener = listener;
            return { dispose: () => { messageListener = null; } };
          }
        },
        reveal: () => {},
        dispose: () => {
          if (disposeListener) {
            const cb = disposeListener;
            disposeListener = null;
            cb();
          }
        },
        onDidDispose: (listener: any) => {
          disposeListener = listener;
          return { dispose: () => { disposeListener = null; } };
        }
      };
    },
    showTextDocument: async (doc: any, _options?: any) => {
      const sel = _options?.selection instanceof Range
        ? new Selection(_options.selection.start, _options.selection.end)
        : new Selection(new Position(0, 0), new Position(0, 0));
      const editor = {
        document: doc,
        selection: sel,
        revealRange: (_range: any, _revealType?: any) => {
          (editor as any).lastRevealedRange = _range;
        }
      };
      (mockVscode.window as any).activeTextEditor = editor;
      return editor;
    }
  },
  ViewColumn,
  TextEditorRevealType,
  env: {
    isTelemetryEnabled: true
  },
  workspace: {
    openTextDocument: async (uriOrPath: any) => {
      let fsPath = typeof uriOrPath === 'string' ? uriOrPath : uriOrPath?.fsPath ?? String(uriOrPath);
      let uri: Uri;
      if (typeof uriOrPath === 'string') {
        if (uriOrPath.startsWith('file://')) {
          uri = Uri.parse(uriOrPath);
          fsPath = uri.fsPath;
        } else {
          uri = Uri.file(uriOrPath);
        }
      } else {
        uri = uriOrPath;
      }
      let content = '';
      try {
        const fsModule = require('fs');
        if (fsPath && fsModule.existsSync(fsPath) && !fsModule.statSync(fsPath).isDirectory()) {
          content = fsModule.readFileSync(fsPath, 'utf-8').replace(/\r\n/g, '\n');
        }
      } catch {
        content = '';
      }
      const lines = content.split(/\r?\n/);
      return {
        uri,
        fileName: fsPath,
        getText: (range?: Range) => {
          if (!range) return content;
          let startOffset = 0;
          for (let i = 0; i < range.start.line && i < lines.length; i++) {
            startOffset += lines[i].length + 1;
          }
          startOffset += range.start.character;
          let endOffset = 0;
          for (let i = 0; i < range.end.line && i < lines.length; i++) {
            endOffset += lines[i].length + 1;
          }
          endOffset += range.end.character;
          return content.substring(startOffset, endOffset);
        },
        offsetAt: (pos: Position) => {
          let offset = 0;
          for (let i = 0; i < pos.line && i < lines.length; i++) {
            offset += lines[i].length + 1;
          }
          return offset + (pos.character || 0);
        },
        positionAt: (offset: number) => {
          let remaining = offset;
          for (let i = 0; i < lines.length; i++) {
            const lineLen = lines[i].length + 1;
            if (remaining < lineLen) {
              return new Position(i, remaining);
            }
            remaining -= lineLen;
          }
          return new Position(lines.length - 1, (lines[lines.length - 1] || '').length);
        },
        getWordRangeAtPosition: (pos: Position) => {
          const line = lines[pos.line] || '';
          const wordRegex = /[a-zA-Z_]\w*/g;
          let m: RegExpExecArray | null;
          while ((m = wordRegex.exec(line)) !== null) {
            if (pos.character >= m.index && pos.character <= m.index + m[0].length) {
              return new Range(new Position(pos.line, m.index), new Position(pos.line, m.index + m[0].length));
            }
          }
          return undefined;
        },
        lineCount: lines.length,
        lineAt: (lineIdx: number) => ({ text: lines[lineIdx] || '' })
      };
    },
    getConfiguration: (section?: string) => ({
      get: (key: string, defaultValue?: any) => {
        const fullKey = section ? `${section}.${key}` : key;
        const configStore = (mockVscode.workspace as any)._config || {};
        if (fullKey in configStore) return configStore[fullKey];
        if (key in configStore) return configStore[key];
        return defaultValue;
      },
      update: async (key: string, value: any) => {
        const fullKey = section ? `${section}.${key}` : key;
        const configStore = (mockVscode.workspace as any)._config || {};
        configStore[fullKey] = value;
        configStore[key] = value;
        (mockVscode.workspace as any)._config = configStore;
      }
    }),
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose: () => {} }),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {}
    }),
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
    workspaceFolders: [],
    isTrusted: true
  },
  commands: {
    _commands: new Map<string, Function>(),
    registerCommand: (cmd: string, callback: any) => {
      (mockVscode.commands as any)._commands.set(cmd, callback);
      return {
        dispose: () => {
          (mockVscode.commands as any)._commands.delete(cmd);
        }
      };
    },
    executeCommand: async (cmd: string, ...args: any[]) => {
      const fn = (mockVscode.commands as any)._commands.get(cmd);
      if (fn) {
        return fn(...args);
      }
      return undefined;
    }
  },
  tasks: {
    registerTaskProvider: () => ({ dispose: () => {} }),
    onDidEndTaskProcess: (_cb: any) => ({ dispose: () => {} }),
    onDidEndTask: (_cb: any) => ({ dispose: () => {} })
  },
  debug: {
    registerDebugConfigurationProvider: () => ({ dispose: () => {} }),
    registerDebugAdapterDescriptorFactory: () => ({ dispose: () => {} })
  },
  languages: {
    registerCodeLensProvider: () => ({ dispose: () => {} }),
    registerCompletionItemProvider: () => ({ dispose: () => {} }),
    registerCodeActionsProvider: () => ({ dispose: () => {} }),
    registerInlayHintsProvider: () => ({ dispose: () => {} }),
    registerHoverProvider: () => ({ dispose: () => {} }),
    registerDefinitionProvider: () => ({ dispose: () => {} }),
    registerEvaluatableExpressionProvider: () => ({ dispose: () => {} }),
    createDiagnosticCollection: (name?: string) => ({
      name: name ?? 'default',
      set: () => {},
      delete: () => {},
      clear: () => {},
      dispose: () => {}
    })
  },
  tests: {
    createTestController: (id: string, label: string) => {
      const itemsMap = new Map<string, any>();
      const controller: any = {
        id,
        label,
        items: {
          get: (k: string) => itemsMap.get(k),
          add: (item: any) => itemsMap.set(item.id, item),
          delete: (k: string) => itemsMap.delete(k),
          replace: (items: any[]) => {
            itemsMap.clear();
            items.forEach((it) => itemsMap.set(it.id, it));
          },
          forEach: (fn: any) => itemsMap.forEach(fn),
          [Symbol.iterator]: () => itemsMap.values()
        },
        createTestItem: (itemId: string, itemLabel: string, uri?: any) => {
          const childrenMap = new Map<string, any>();
          return {
            id: itemId,
            label: itemLabel,
            uri,
            range: undefined,
            children: {
              get: (k: string) => childrenMap.get(k),
              add: (c: any) => childrenMap.set(c.id, c),
              delete: (k: string) => childrenMap.delete(k),
              replace: (cItems: any[]) => {
                childrenMap.clear();
                cItems.forEach((c) => childrenMap.set(c.id, c));
              },
              forEach: (fn: any) => childrenMap.forEach(fn),
              [Symbol.iterator]: () => childrenMap.values()
            }
          };
        },
        createRunProfile: (name: string, kind: number, _handler: any) => ({
          name,
          kind,
          dispose: () => {}
        }),
        dispose: () => {}
      };
      return controller;
    }
  },
  TestRunProfileKind: {
    Run: 1,
    Debug: 2,
    Coverage: 3
  },
  EvaluatableExpression,
  SnippetTextEdit
};

const originalRequire = (Module.prototype as any).require;
(Module.prototype as any).require = function (id: string) {
  if (id === 'vscode') {
    return mockVscode;
  }
  return originalRequire.apply(this, arguments);
};
