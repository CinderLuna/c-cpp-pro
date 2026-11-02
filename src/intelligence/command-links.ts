import * as vscode from 'vscode';

/**
 * Builds a markdown command link for triggering reference search for a symbol.
 * If document URI and position are provided, encodes them into the command URI
 * so that the editor moves the caret to the exact symbol location before searching references.
 */
export function makeFindReferencesLink(docUri?: vscode.Uri, pos?: vscode.Position): string {
  if (docUri && pos) {
    const args = encodeURIComponent(JSON.stringify([docUri.toString(), pos.line, pos.character]));
    return `[Find References](command:c-cpp-pro.findReferences?${args})`;
  }
  return '[Find References](command:c-cpp-pro.findReferences)';
}

/**
 * Builds a markdown command link for inspecting struct / class memory layout.
 * If document URI, position, and struct name are provided, encodes them into the command URI
 * so that memory layout inspector can navigate to and resolve the struct definition across files.
 */
export function makeInspectMemoryLayoutLink(
  docUri?: vscode.Uri,
  pos?: vscode.Position,
  structName?: string
): string {
  if (docUri && pos) {
    const args = encodeURIComponent(
      JSON.stringify([docUri.toString(), pos.line, pos.character, structName ?? ''])
    );
    return `[Inspect Memory Layout](command:c-cpp-pro.inspectMemoryLayout?${args})`;
  }
  return '[Inspect Memory Layout](command:c-cpp-pro.inspectMemoryLayout)';
}
