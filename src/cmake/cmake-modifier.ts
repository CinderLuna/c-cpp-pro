import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface DiscoveredTargetLocation {
  name: string;
  type: 'executable' | 'library' | 'sources';
  line: number;
  rawText: string;
}

export class CMakeListsModifier {
  /**
   * Scans CMakeLists.txt content to find declarations of targets:
   * add_executable(name ...), add_library(name ...), or target_sources(name ...)
   */
  public static findTargets(content: string): DiscoveredTargetLocation[] {
    const targets: DiscoveredTargetLocation[] = [];
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;

      // Match add_executable(name ...)
      const execMatch = /\badd_executable\s*\(\s*([A-Za-z0-9_+-]+)/i.exec(line);
      if (execMatch) {
        targets.push({
          name: execMatch[1],
          type: 'executable',
          line: i,
          rawText: line
        });
        continue;
      }

      // Match add_library(name ...)
      const libMatch = /\badd_library\s*\(\s*([A-Za-z0-9_+-]+)/i.exec(line);
      if (libMatch) {
        targets.push({
          name: libMatch[1],
          type: 'library',
          line: i,
          rawText: line
        });
        continue;
      }

      // Match target_sources(name ...)
      const srcMatch = /\btarget_sources\s*\(\s*([A-Za-z0-9_+-]+)/i.exec(line);
      if (srcMatch) {
        targets.push({
          name: srcMatch[1],
          type: 'sources',
          line: i,
          rawText: line
        });
        continue;
      }
    }

    return targets;
  }

  /**
   * Inserts a source file into CMakeLists.txt content for the given target,
   * preferring existing target_sources() blocks or inserting right into the target declaration.
   */
  public static insertSourceIntoTarget(
    content: string,
    targetName: string,
    relativeSourcePath: string
  ): string {
    const lines = content.split(/\r?\n/);
    const normSource = relativeSourcePath.replace(/\\/g, '/');

    // 1. Check if source is already present
    if (content.includes(normSource)) {
      return content;
    }

    // 2. Look for existing target_sources(targetName ...)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = new RegExp(`\\btarget_sources\\s*\\(\\s*${targetName}\\b`, 'i').exec(line);
      if (match) {
        if (line.includes(')')) {
          const closeIdx = line.lastIndexOf(')');
          const updatedLine = line.slice(0, closeIdx).trimEnd() + ` ${normSource}` + line.slice(closeIdx);
          lines[i] = updatedLine;
          return lines.join('\n');
        }

        // Find closing parenthesis of this target_sources call
        for (let j = i + 1; j < lines.length; j++) {
          const closeIdx = lines[j].indexOf(')');
          if (closeIdx !== -1) {
            // Determine indentation
            const indentMatch = /^\s*/.exec(lines[i + 1] || lines[i]);
            const indent = indentMatch ? indentMatch[0] : '  ';
            lines.splice(j, 0, `${indent}${normSource}`);
            return lines.join('\n');
          }
        }
      }
    }

    // 3. Fallback: Insert into add_executable(targetName ...) or add_library(targetName ...)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = new RegExp(`\\b(?:add_executable|add_library)\\s*\\(\\s*${targetName}\\b`, 'i').exec(line);
      if (match) {
        // If single line like `add_executable(foo main.cpp)`
        if (line.includes(')')) {
          const closeIdx = line.lastIndexOf(')');
          const updatedLine = line.slice(0, closeIdx).trimEnd() + ` ${normSource}` + line.slice(closeIdx);
          lines[i] = updatedLine;
          return lines.join('\n');
        }

        // Multi-line declaration: find closing parenthesis
        for (let j = i; j < lines.length; j++) {
          if (lines[j].includes(')')) {
            const indentMatch = /^\s*/.exec(lines[i + 1] || lines[i]);
            const indent = indentMatch ? indentMatch[0] : '  ';
            lines.splice(j, 0, `${indent}${normSource}`);
            return lines.join('\n');
          }
        }
      }
    }

    // 4. Default fallback: Append target_sources(targetName PRIVATE <source>) at bottom of file
    lines.push('', `target_sources(${targetName} PRIVATE ${normSource})`);
    return lines.join('\n');
  }
}

export class CMakeCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.Refactor];

  public async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection
  ): Promise<vscode.CodeAction[]> {
    const ext = path.extname(document.fileName).toLowerCase();
    if (!['.cpp', '.cxx', '.cc', '.c', '.h', '.hpp'].includes(ext)) {
      return [];
    }

    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return [];

    const cmakeListsPath = path.join(folder.uri.fsPath, 'CMakeLists.txt');
    if (!fs.existsSync(cmakeListsPath)) return [];

    const relativeSrc = path.relative(folder.uri.fsPath, document.fileName).replace(/\\/g, '/');
    let cmakeContent = '';
    try {
      cmakeContent = fs.readFileSync(cmakeListsPath, 'utf8');
    } catch {
      return [];
    }

    // If already in CMakeLists.txt, do not offer
    if (cmakeContent.includes(relativeSrc)) {
      return [];
    }

    const targets = CMakeListsModifier.findTargets(cmakeContent);
    if (targets.length === 0) return [];

    const actions: vscode.CodeAction[] = [];

    for (const target of targets) {
      const action = new vscode.CodeAction(
        `C/C++ Pro: Add to CMake target '${target.name}'`,
        vscode.CodeActionKind.Refactor
      );

      action.command = {
        command: 'c-cpp-pro.cmake.addSourceToTarget',
        title: `Add ${path.basename(document.fileName)} to CMake target '${target.name}'`,
        arguments: [folder.uri.fsPath, target.name, relativeSrc]
      };

      actions.push(action);
    }

    return actions;
  }
}
