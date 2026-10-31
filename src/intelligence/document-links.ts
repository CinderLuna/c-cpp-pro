import * as vscode from 'vscode';
import {
  parseIncludeLine,
  resolveLocalHeaderPath,
  isStandardHeader
} from './header-hover-provider';

/**
 * Provides clickable document links on #include directives to open header files directly.
 */
export class CppIncludeDocumentLinkProvider implements vscode.DocumentLinkProvider {
  public provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    const lineCount = document.lineCount;

    for (let i = 0; i < lineCount; i++) {
      if (_token.isCancellationRequested) {
        return [];
      }

      const line = document.lineAt(i);
      const text = line.text;
      if (!text.includes('#') || !text.includes('include')) {
        continue;
      }

      const parsed = parseIncludeLine(text, i);
      if (!parsed) {
        continue;
      }

      if (parsed.isStandard && isStandardHeader(parsed.headerName)) {
        continue;
      }

      const resolved = resolveLocalHeaderPath(parsed.headerName, document.uri);
      if (resolved) {
        const quoteStart = text.indexOf(parsed.headerText);
        const linkRange = quoteStart !== -1
          ? new vscode.Range(i, quoteStart, i, quoteStart + parsed.headerText.length)
          : parsed.range;
        const link = new vscode.DocumentLink(linkRange, vscode.Uri.file(resolved));
        link.tooltip = `Open ${parsed.headerName}`;
        links.push(link);
      }
    }

    return links;
  }
}
