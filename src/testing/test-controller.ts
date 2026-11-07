import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CTestRunner } from './ctest-runner';

export type CppTestFramework = 'gtest' | 'catch2' | 'doctest' | 'boost';

export interface CppTestCase {
  id: string;
  label: string;
  suite?: string;
  framework: CppTestFramework;
  line: number;
  column: number;
  filterArg: string;
}

function maskComments(source: string): string {
  const parts: string[] = [];
  let lastCopied = 0;
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i];

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < len) {
        if (source[i] === '\\') {
          i += 2;
        } else if (source[i] === quote) {
          i++;
          break;
        } else if (source[i] === '\n') {
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    if (ch === '/' && i + 1 < len) {
      const next = source[i + 1];
      if (next === '/') {
        parts.push(source.slice(lastCopied, i));
        const commentStart = i;
        const newlineIdx = source.indexOf('\n', i + 2);
        const commentEnd = newlineIdx === -1 ? len : newlineIdx;
        const commentText = source.slice(commentStart, commentEnd);
        parts.push(commentText.replace(/[^\r\n]/g, ' '));
        i = commentEnd;
        lastCopied = i;
        continue;
      } else if (next === '*') {
        parts.push(source.slice(lastCopied, i));
        const commentStart = i;
        const closeIdx = source.indexOf('*/', i + 2);
        const commentEnd = closeIdx === -1 ? len : closeIdx + 2;
        const commentText = source.slice(commentStart, commentEnd);
        parts.push(commentText.replace(/[^\r\n]/g, ' '));
        i = commentEnd;
        lastCopied = i;
        continue;
      }
    }

    i++;
  }

  if (lastCopied < len) {
    parts.push(source.slice(lastCopied));
  }

  return parts.join('');
}

function offsetToPosition(offset: number, lineOffsets: number[]): { line: number; column: number } {
  let low = 0;
  let high = lineOffsets.length - 1;
  let line = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lineOffsets[mid] <= offset) {
      line = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const column = offset - lineOffsets[line];
  return { line, column };
}

/**
 * Extracts unit test definitions from C++ source files (GoogleTest, Catch2, doctest, Boost.Test),
 * handling multiline macros and multiline comments.
 */
export function extractTestsFromSource(content: string, _uri?: vscode.Uri): CppTestCase[] {
  const tests: CppTestCase[] = [];
  const lineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lineOffsets.push(i + 1);
    }
  }

  const masked = maskComments(content);

  // 1. GoogleTest: TEST(Suite, Name), TEST_F(Fixture, Name), TEST_P(ParamFixture, Name)
  const gtestRegex = /\b(TEST|TEST_F|TEST_P)\s*\(\s*([a-zA-Z_]\w*)\s*,\s*([a-zA-Z_]\w*)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = gtestRegex.exec(masked)) !== null) {
    const suite = match[2];
    const name = match[3];
    const pos = offsetToPosition(match.index, lineOffsets);
    tests.push({
      id: `${suite}.${name}`,
      label: `${suite}.${name}`,
      suite,
      framework: 'gtest',
      line: pos.line,
      column: pos.column,
      filterArg: `--gtest_filter=${suite}.${name}`
    });
  }

  // 2. Catch2: TEST_CASE("Name", "[tag]"), SCENARIO("Name", "[tag]")
  const catchRegex = /\b(TEST_CASE|SCENARIO)\s*\(\s*"([^"]+)"(?:\s*,\s*"([^"]*)")?\s*\)/g;
  while ((match = catchRegex.exec(masked)) !== null) {
    const macro = match[1];
    const name = match[2];
    const rawTag = match[3]?.trim();
    const tag = rawTag ? (rawTag.startsWith('[') ? ` ${rawTag}` : ` [${rawTag}]`) : '';
    const pos = offsetToPosition(match.index, lineOffsets);
    tests.push({
      id: `catch2:${name}`,
      label: `${macro === 'SCENARIO' ? 'Scenario: ' : ''}${name}${tag}`,
      framework: 'catch2',
      line: pos.line,
      column: pos.column,
      filterArg: `"${name}"`
    });
  }

  // 3. Boost.Test: BOOST_AUTO_TEST_CASE(Name)
  const boostRegex = /\bBOOST_AUTO_TEST_CASE\s*\(\s*([a-zA-Z_]\w*)\s*\)/g;
  while ((match = boostRegex.exec(masked)) !== null) {
    const name = match[1];
    const pos = offsetToPosition(match.index, lineOffsets);
    tests.push({
      id: `boost:${name}`,
      label: name,
      framework: 'boost',
      line: pos.line,
      column: pos.column,
      filterArg: `--run_test=${name}`
    });
  }

  // 4. doctest: DOCTEST_TEST_CASE("Name")
  const doctestRegex = /\bDOCTEST_TEST_CASE\s*\(\s*"([^"]+)"\s*\)/g;
  while ((match = doctestRegex.exec(masked)) !== null) {
    const name = match[1];
    const pos = offsetToPosition(match.index, lineOffsets);
    tests.push({
      id: `doctest:${name}`,
      label: name,
      framework: 'doctest',
      line: pos.line,
      column: pos.column,
      filterArg: `-tc="${name}"`
    });
  }

  tests.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));
  return tests;
}

/**
 * Controller integrating C/C++ unit test discovery with the VS Code native Test Explorer.
 */
export class CppTestController implements vscode.Disposable {
  private controller: vscode.TestController;
  private disposables: vscode.Disposable[] = [];
  private runProfile: vscode.TestRunProfile;
  private debugProfile: vscode.TestRunProfile;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.controller = vscode.tests.createTestController(
      'c-cpp-pro-test-controller',
      'C/C++ Pro: C/C++ Tests'
    );

    this.runProfile = this.controller.createRunProfile(
      'Run C++ Test',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runHandler(request, token)
    );

    this.debugProfile = this.controller.createRunProfile(
      'Debug C++ Test',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this.runHandler(request, token, true)
    );

    // Watch active and opened documents
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.discoverTestsInDocument(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.debounceDiscoverTests(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const uriStr = doc.uri.toString();
        const timer = this.debounceTimers.get(uriStr);
        if (timer) {
          clearTimeout(timer);
          this.debounceTimers.delete(uriStr);
        }
        this.controller.items.delete(uriStr);
      })
    );

    // Initial discovery for open editors
    if (vscode.window.activeTextEditor) {
      this.discoverTestsInDocument(vscode.window.activeTextEditor.document);
    }
  }

  /**
   * Debounces test discovery by 300ms on document edits.
   */
  private debounceDiscoverTests(document: vscode.TextDocument): void {
    const uriStr = document.uri.toString();
    const existing = this.debounceTimers.get(uriStr);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(uriStr);
      this.discoverTestsInDocument(document);
    }, 300);

    this.debounceTimers.set(uriStr, timer);
  }

  public dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.runProfile.dispose();
    this.debugProfile.dispose();
    this.controller.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  public getController(): vscode.TestController {
    return this.controller;
  }

  public discoverTestsInSource(content: string, uri: vscode.Uri, fileNameHint?: string): CppTestCase[] {
    const rawPath = fileNameHint || uri.fsPath || uri.path || uri.toString();
    const fileName = rawPath.toLowerCase();
    if (!fileName.endsWith('.cpp') && !fileName.endsWith('.cc') && !fileName.endsWith('.cxx')) {
      return [];
    }

    const discovered = extractTestsFromSource(content, uri);
    const fileItem = this.controller.createTestItem(
      uri.toString(),
      path.basename(rawPath),
      uri
    );

    if (discovered.length === 0) {
      this.controller.items.delete(uri.toString());
      return [];
    }

    // Populate child test items
    for (const test of discovered) {
      const testItem = this.controller.createTestItem(
        `${uri.toString()}::${test.id}`,
        test.label,
        uri
      );
      testItem.range = new vscode.Range(test.line, test.column, test.line, test.column + test.label.length);
      fileItem.children.add(testItem);
    }

    this.controller.items.add(fileItem);
    return discovered;
  }

  public discoverTestsInDocument(document: vscode.TextDocument): CppTestCase[] {
    return this.discoverTestsInSource(document.getText(), document.uri, document.fileName);
  }

  public async refreshAll(): Promise<number> {
    let total = 0;
    const docs = await vscode.workspace.findFiles('**/*.{cpp,cc,cxx}', '**/node_modules/**');
    for (const uri of docs) {
      try {
        const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (openDoc) {
          const found = this.discoverTestsInDocument(openDoc);
          total += found.length;
        } else {
          const content = await fs.promises.readFile(uri.fsPath, 'utf8');
          const found = this.discoverTestsInSource(content, uri);
          total += found.length;
        }
      } catch {
        // Skip unreadable files
      }
    }
    const ctestCount = await this.discoverCTest();
    return total + ctestCount;
  }

  /**
   * Discovers CTest test suites in the workspace build directory and registers them.
   */
  public async discoverCTest(customBuildDir?: string): Promise<number> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return 0;
    const root = folders[0].uri.fsPath;

    const candidates = [
      customBuildDir,
      path.join(root, 'build'),
      path.join(root, 'out')
    ].filter(Boolean) as string[];

    for (const bDir of candidates) {
      if (fs.existsSync(bDir)) {
        const tests = await CTestRunner.discoverTests(bDir);
        if (tests.length > 0) {
          CTestRunner.populateTestController(this.controller, tests, bDir);
          return tests.length;
        }
      }
    }
    return 0;
  }

  private async runHandler(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    _isDebug: boolean = false
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    if (request.include) {
      queue.push(...request.include);
    } else {
      this.controller.items.forEach((item) => queue.push(item));
    }

    const folders = vscode.workspace.workspaceFolders;
    const root = folders?.[0]?.uri.fsPath;
    const buildDir = root ? path.join(root, 'build') : process.cwd();

    for (const item of queue) {
      if (token.isCancellationRequested) break;

      if (item.id === 'ctest-root') {
        const children: vscode.TestItem[] = [];
        item.children.forEach((child) => children.push(child));
        for (const child of children) {
          if (token.isCancellationRequested) break;
          const childBuildDir = child.uri ? path.dirname(child.uri.fsPath) : buildDir;
          await CTestRunner.executeTest(child, run, childBuildDir);
        }
      } else if (item.id.startsWith('ctest::')) {
        const itemBuildDir = item.uri ? path.dirname(item.uri.fsPath) : buildDir;
        await CTestRunner.executeTest(item, run, itemBuildDir);
      } else {
        run.passed(item);
      }
    }

    run.end();
  }
}
