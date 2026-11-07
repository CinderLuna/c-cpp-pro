import * as vscode from 'vscode';
import * as path from 'path';

export interface ParsedDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: vscode.DiagnosticSeverity;
  code?: string;
  message: string;
}

export class StreamingProblemMatcher implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private pendingDiagnostics = new Map<string, vscode.Diagnostic[]>();

  constructor(collectionName = 'c-cpp-pro-build') {
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection(collectionName);
  }

  public clear(): void {
    this.diagnosticCollection.clear();
    this.pendingDiagnostics.clear();
  }

  /**
   * Parses an individual line of compiler output from GCC, Clang, or MSVC.
   */
  public parseLine(line: string, workspaceRoot?: string): ParsedDiagnostic | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;

    // 1. GCC / Clang regex: file:line:col: (error|warning|fatal error|note): message
    // Handles Windows drive letters (C:/...) and POSIX paths
    const gccMatch = /^(?:([a-zA-Z]:[\\/][^:\r\n]+)|([^:\r\n]+)):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.*)$/i.exec(trimmed);
    if (gccMatch) {
      const rawFile = (gccMatch[1] || gccMatch[2]).trim();
      const lineNum = Math.max(0, parseInt(gccMatch[3], 10) - 1);
      const colNum = Math.max(0, parseInt(gccMatch[4] || '1', 10) - 1);
      const kind = gccMatch[5].toLowerCase();
      const message = gccMatch[6].trim();

      let severity = vscode.DiagnosticSeverity.Error;
      if (kind === 'warning') severity = vscode.DiagnosticSeverity.Warning;
      else if (kind === 'note') severity = vscode.DiagnosticSeverity.Information;

      const fullPath = workspaceRoot && !path.isAbsolute(rawFile)
        ? path.join(workspaceRoot, rawFile)
        : rawFile;

      return {
        file: fullPath.replace(/\\/g, '/'),
        line: lineNum,
        column: colNum,
        severity,
        message
      };
    }

    // 2. MSVC regex: file(line[,col]): (error|warning|fatal error) Cxxxx: message
    // Handles Windows drive letters and arbitrary file paths before (line,col)
    const msvcMatch = /^(.*?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning)\s+([A-Za-z0-9]+)\s*:\s*(.*)$/i.exec(trimmed);
    if (msvcMatch) {
      const rawFile = msvcMatch[1].trim();
      const lineNum = Math.max(0, parseInt(msvcMatch[2], 10) - 1);
      const colNum = Math.max(0, parseInt(msvcMatch[3] || '1', 10) - 1);
      const kind = msvcMatch[4].toLowerCase();
      const code = msvcMatch[5].trim();
      const message = msvcMatch[6].trim();

      let severity = vscode.DiagnosticSeverity.Error;
      if (kind === 'warning') severity = vscode.DiagnosticSeverity.Warning;

      const fullPath = workspaceRoot && !path.isAbsolute(rawFile)
        ? path.join(workspaceRoot, rawFile)
        : rawFile;

      return {
        file: fullPath.replace(/\\/g, '/'),
        line: lineNum,
        column: colNum,
        severity,
        code,
        message: `${code}: ${message}`
      };
    }

    return null;
  }

  /**
   * Ingests a line of compiler output, parses any diagnostic, and adds it to the collection.
   */
  public ingestLine(line: string, workspaceRoot?: string): ParsedDiagnostic | null {
    const parsed = this.parseLine(line, workspaceRoot);
    if (!parsed) return null;

    const range = new vscode.Range(
      parsed.line,
      parsed.column,
      parsed.line,
      parsed.column + 20
    );

    const diag = new vscode.Diagnostic(range, parsed.message, parsed.severity);
    if (parsed.code) {
      diag.code = parsed.code;
    }
    diag.source = 'c-cpp-pro-compiler';

    const uri = vscode.Uri.file(parsed.file);
    const uriKey = uri.toString();

    let list = this.pendingDiagnostics.get(uriKey);
    if (!list) {
      list = [];
      this.pendingDiagnostics.set(uriKey, list);
    }
    list.push(diag);
    this.diagnosticCollection.set(uri, list);

    return parsed;
  }

  public getCollection(): vscode.DiagnosticCollection {
    return this.diagnosticCollection;
  }

  public dispose(): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
    this.pendingDiagnostics.clear();
  }
}
