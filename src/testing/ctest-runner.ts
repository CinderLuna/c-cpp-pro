import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CTestDiscoveryItem {
  name: string;
  command: string[];
  workingDirectory?: string;
  properties?: Array<{ name: string; value: string }>;
}

export class CTestRunner {
  /**
   * Discovers CTest test suites in the given build directory.
   * Attempts `ctest --show-only=json-v1` first, falling back to parsing `CTestTestfile.cmake`.
   */
  public static async discoverTests(buildDir: string): Promise<CTestDiscoveryItem[]> {
    if (!fs.existsSync(buildDir)) return [];

    // 1. Try running ctest --show-only=json-v1
    try {
      const { stdout } = await execFileAsync('ctest', ['--show-only=json-v1'], {
        cwd: buildDir,
        timeout: 5000,
        windowsHide: true
      });

      const parsed = JSON.parse(stdout);
      if (parsed.tests && Array.isArray(parsed.tests)) {
        return parsed.tests.map((t: any) => ({
          name: t.name || 'unnamed_test',
          command: Array.isArray(t.command) ? t.command : [],
          workingDirectory: t.workingDirectory || buildDir,
          properties: t.properties
        }));
      }
    } catch {
      // Fallback to parsing CTestTestfile.cmake directly on disk
    }

    // 2. Fallback: Parse CTestTestfile.cmake
    return this.parseCTestTestfile(buildDir);
  }

  /**
   * Statically parses CTestTestfile.cmake if ctest CLI is not found or fails.
   */
  public static parseCTestTestfile(buildDir: string): CTestDiscoveryItem[] {
    const testFile = path.join(buildDir, 'CTestTestfile.cmake');
    if (!fs.existsSync(testFile)) return [];

    const tests: CTestDiscoveryItem[] = [];
    try {
      const content = fs.readFileSync(testFile, 'utf8');
      // Match: add_test("test_name" "/path/to/binary" "arg1" ...)
      const regex = /add_test\s*\(\s*["']?([^"'\s)]+)["']?\s+([^)]+)\)/gi;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(content)) !== null) {
        const testName = match[1];
        const rawArgs = match[2];
        const argsMatch = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        const cleanArgs = argsMatch.map((a) => a.replace(/^["']|["']$/g, ''));

        tests.push({
          name: testName,
          command: cleanArgs,
          workingDirectory: buildDir
        });
      }
    } catch {
      // Ignore read errors
    }

    return tests;
  }

  /**
   * Registers discovered CTest test items into a VS Code TestController.
   */
  public static populateTestController(
    controller: vscode.TestController,
    tests: CTestDiscoveryItem[],
    buildDir: string
  ): vscode.TestItem | null {
    if (tests.length === 0) {
      controller.items.delete('ctest-root');
      return null;
    }

    let rootItem = controller.items.get('ctest-root');
    if (!rootItem) {
      rootItem = controller.createTestItem('ctest-root', 'CTest Suites');
      controller.items.add(rootItem);
    }

    // Clean existing children and repopulate
    rootItem.children.replace([]);

    for (const test of tests) {
      const item = controller.createTestItem(
        `ctest::${test.name}`,
        test.name,
        vscode.Uri.file(path.join(buildDir, 'CTestTestfile.cmake'))
      );
      item.description = test.command.length > 0 ? path.basename(test.command[0]) : undefined;
      rootItem.children.add(item);
    }

    return rootItem;
  }

  /**
   * Runs a single CTest test and records the outcome into the active TestRun.
   */
  public static async executeTest(
    item: vscode.TestItem,
    testRun: vscode.TestRun,
    buildDir: string
  ): Promise<boolean> {
    const testName = item.label;
    testRun.started(item);

    const startTime = Date.now();
    try {
      const { stdout } = await execFileAsync('ctest', ['-R', `^${testName}$`, '--output-on-failure'], {
        cwd: buildDir,
        timeout: 30000,
        windowsHide: true
      });

      const duration = Date.now() - startTime;
      testRun.passed(item, duration);
      testRun.appendOutput(stdout.replace(/\r?\n/g, '\r\n'), undefined, item);
      return true;
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const errorMsg = err.stdout || err.stderr || err.message || 'CTest execution failed';
      testRun.failed(
        item,
        new vscode.TestMessage(errorMsg),
        duration
      );
      testRun.appendOutput((err.stdout || err.message || '').replace(/\r?\n/g, '\r\n'), undefined, item);
      return false;
    }
  }
}
