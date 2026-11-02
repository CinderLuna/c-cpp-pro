import * as fs from 'fs';
import * as vscode from 'vscode';
import { NativeBridge } from '../native/native-bridge';
import { canonicalizePath, resolveLocalHeaderPath } from '../intelligence/header-hover-provider';

export interface FieldLayout {
  name: string;
  type: string;
  offset: number;
  size: number;
  alignment: number;
  isPadding: boolean;
  paddingSize?: number;
}

export interface StructLayout {
  name: string;
  totalSize: number;
  alignment: number;
  paddingBytes: number;
  cacheLines: number; // number of 64-byte cache lines
  fields: FieldLayout[];
  isPacked: boolean;
  optimizedSize?: number;
  recommendation?: string;
}

export type DataModel = 'LP64' | 'LLP64';

export interface TypeInfo {
  size: number;
  alignment: number;
}

const TYPE_SPECS_LP64: Record<string, TypeInfo> = {
  'bool': { size: 1, alignment: 1 },
  'char': { size: 1, alignment: 1 },
  'signed char': { size: 1, alignment: 1 },
  'unsigned char': { size: 1, alignment: 1 },
  'int8_t': { size: 1, alignment: 1 },
  'uint8_t': { size: 1, alignment: 1 },
  'short': { size: 2, alignment: 2 },
  'unsigned short': { size: 2, alignment: 2 },
  'int16_t': { size: 2, alignment: 2 },
  'uint16_t': { size: 2, alignment: 2 },
  'int': { size: 4, alignment: 4 },
  'unsigned int': { size: 4, alignment: 4 },
  'unsigned': { size: 4, alignment: 4 },
  'int32_t': { size: 4, alignment: 4 },
  'uint32_t': { size: 4, alignment: 4 },
  'float': { size: 4, alignment: 4 },
  'long': { size: 8, alignment: 8 },
  'unsigned long': { size: 8, alignment: 8 },
  'long long': { size: 8, alignment: 8 },
  'unsigned long long': { size: 8, alignment: 8 },
  'int64_t': { size: 8, alignment: 8 },
  'uint64_t': { size: 8, alignment: 8 },
  'double': { size: 8, alignment: 8 },
  'long double': { size: 16, alignment: 16 },
  'size_t': { size: 8, alignment: 8 },
  'uintptr_t': { size: 8, alignment: 8 },
  'intptr_t': { size: 8, alignment: 8 },
  'ptrdiff_t': { size: 8, alignment: 8 },
  'char8_t': { size: 1, alignment: 1 },
  'char16_t': { size: 2, alignment: 2 },
  'char32_t': { size: 4, alignment: 4 },
  'wchar_t': { size: 4, alignment: 4 },
  'DWORD': { size: 4, alignment: 4 },
  'WORD': { size: 2, alignment: 2 },
  'BYTE': { size: 1, alignment: 1 },
  'BOOL': { size: 4, alignment: 4 },
  'HANDLE': { size: 8, alignment: 8 },
  'HWND': { size: 8, alignment: 8 },
  'HDC': { size: 8, alignment: 8 },
  'HINSTANCE': { size: 8, alignment: 8 }
};

const TYPE_SPECS_LLP64: Record<string, TypeInfo> = {
  ...TYPE_SPECS_LP64,
  'long': { size: 4, alignment: 4 },
  'unsigned long': { size: 4, alignment: 4 },
  'long double': { size: 8, alignment: 8 },
  'wchar_t': { size: 2, alignment: 2 }
};

/**
 * Resolves the byte size and alignment for a C/C++ type in a 64-bit architecture.
 * Supports LP64 (POSIX / GCC / Clang default) and LLP64 (Windows MSVC).
 */
export function resolveTypeInfo(typeStr: string, dataModel: DataModel = 'LP64'): TypeInfo {
  const trimmed = typeStr.trim();

  // Pointer types are always 8 bytes on 64-bit architectures
  if (trimmed.endsWith('*') || trimmed.endsWith('&')) {
    return { size: 8, alignment: 8 };
  }

  // Check for fixed array: type[N] or multi-dimensional type[N][M]...
  const multiArrayMatch = trimmed.match(/^([^\[]+)((?:\[\d+\])+)$/);
  if (multiArrayMatch) {
    const elemType = multiArrayMatch[1].trim();
    const dims = [...multiArrayMatch[2].matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10));
    const totalCount = dims.reduce((acc, val) => acc * val, 1);
    const elemInfo = resolveTypeInfo(elemType, dataModel);
    return {
      size: elemInfo.size * totalCount,
      alignment: elemInfo.alignment
    };
  }

  // Normalize spaces
  const normalized = trimmed.replace(/\s+/g, ' ');
  const specs = dataModel === 'LLP64' ? TYPE_SPECS_LLP64 : TYPE_SPECS_LP64;
  if (specs[normalized]) {
    return specs[normalized];
  }

  // Check for enum types or enum-like identifiers (default to 4-byte int in C++)
  if (
    normalized.startsWith('enum ') ||
    /(?:Type|Kind|Mode|State|Status|Flag|Flags|Code|Id|Unit)$/i.test(normalized)
  ) {
    return { size: 4, alignment: 4 };
  }

  // Fallback heuristic: word-aligned 8-byte pointer/struct
  return { size: 8, alignment: 8 };
}

export interface StructLayoutOptions {
  isPacked?: boolean;
  maxPackAlignment?: number;
  structAlignment?: number;
  skipOptimization?: boolean;
  dataModel?: DataModel;
}

/**
 * Calculates struct / class memory layout including natural alignment padding and cache-line boundaries.
 */
export function calculateStructLayout(
  structName: string,
  rawFields: { type: string; name: string }[],
  options: StructLayoutOptions = {}
): StructLayout {
  const isPacked = !!options.isPacked;
  const packMax = options.maxPackAlignment ?? (isPacked ? 1 : 8);
  const dataModel = options.dataModel ?? 'LP64';

  const fields: FieldLayout[] = [];
  let currentOffset = 0;
  let maxStructAlignment = options.structAlignment ?? 1;
  let totalPaddingBytes = 0;

  for (const field of rawFields) {
    const typeInfo = resolveTypeInfo(field.type, dataModel);
    const fieldAlignment = isPacked ? 1 : Math.min(typeInfo.alignment, packMax);
    maxStructAlignment = Math.max(maxStructAlignment, fieldAlignment);

    // Calculate required padding before this field to satisfy its alignment
    const remainder = currentOffset % fieldAlignment;
    if (remainder !== 0) {
      const padSize = fieldAlignment - remainder;
      fields.push({
        name: `[padding_${padSize}B]`,
        type: 'padding',
        offset: currentOffset,
        size: padSize,
        alignment: 1,
        isPadding: true,
        paddingSize: padSize
      });
      currentOffset += padSize;
      totalPaddingBytes += padSize;
    }

    fields.push({
      name: field.name,
      type: field.type,
      offset: currentOffset,
      size: typeInfo.size,
      alignment: fieldAlignment,
      isPadding: false
    });

    currentOffset += typeInfo.size;
  }

  // Trailing padding to align entire struct to maxStructAlignment
  const tailRemainder = currentOffset % maxStructAlignment;
  if (tailRemainder !== 0 && !isPacked) {
    const tailPad = maxStructAlignment - tailRemainder;
    fields.push({
      name: `[tail_padding_${tailPad}B]`,
      type: 'padding',
      offset: currentOffset,
      size: tailPad,
      alignment: 1,
      isPadding: true,
      paddingSize: tailPad
    });
    currentOffset += tailPad;
    totalPaddingBytes += tailPad;
  }

  const totalSize = currentOffset;
  const cacheLines = Math.max(1, Math.ceil(totalSize / 64));

  // Compute optimized layout by ordering fields by descending alignment/size
  let optimizedSize: number | undefined;
  let recommendation: string | undefined;

  if (totalPaddingBytes > 0 && !isPacked && !options.skipOptimization) {
    const sortedFields = [...rawFields].sort((a, b) => {
      const aInfo = resolveTypeInfo(a.type, dataModel);
      const bInfo = resolveTypeInfo(b.type, dataModel);
      return bInfo.alignment !== aInfo.alignment
        ? bInfo.alignment - aInfo.alignment
        : bInfo.size - aInfo.size;
    });

    const optLayout = calculateStructLayout(structName, sortedFields, { isPacked: false, skipOptimization: true, dataModel });
    optimizedSize = optLayout.totalSize;

    if (optimizedSize < totalSize) {
      const saved = totalSize - optimizedSize;
      const reorderList = sortedFields.map(f => f.name).join(', ');
      recommendation = `Reorder fields to [${reorderList}] to save ${saved} byte${saved > 1 ? 's' : ''} (${Math.round((saved / totalSize) * 100)}% reduction).`;
    }
  }

  return {
    name: structName,
    totalSize,
    alignment: maxStructAlignment,
    paddingBytes: totalPaddingBytes,
    cacheLines,
    fields,
    isPacked,
    optimizedSize,
    recommendation
  };
}

/**
 * Generates an ASCII visual diagram of the struct's byte layout.
 */
export function generateLayoutAsciiDiagram(layout: StructLayout): string {
  const lines: string[] = [];
  lines.push(`Struct Layout: ${layout.name} (${layout.totalSize} bytes, alignment: ${layout.alignment})`);
  lines.push(`Cache line footprint: ${layout.cacheLines} line(s) (64B per line)`);
  lines.push('─'.repeat(60));

  for (const field of layout.fields) {
    const hexOffset = `0x${field.offset.toString(16).padStart(4, '0')}`;
    const decOffset = `[+${field.offset.toString().padStart(3, ' ')}]`;
    if (field.isPadding) {
      lines.push(`${hexOffset} ${decOffset} │ ░░ PAD (${field.size} byte${field.size > 1 ? 's' : ''})`);
    } else {
      const sizeStr = `${field.size}B`;
      lines.push(`${hexOffset} ${decOffset} │ ■ ${field.name.padEnd(20, ' ')} : ${field.type} (${sizeStr})`);
    }
  }

  lines.push('─'.repeat(60));
  if (layout.paddingBytes > 0) {
    const pct = Math.round((layout.paddingBytes / layout.totalSize) * 100);
    lines.push(`Wasted padding: ${layout.paddingBytes} bytes (${pct}% overhead)`);
  } else {
    lines.push('Memory density: 100% optimal (0 padding bytes)');
  }

  if (layout.recommendation) {
    lines.push(`Tip: ${layout.recommendation}`);
  }

  return lines.join('\n');
}

/**
 * Generates rich markdown content for hovers or webview panels.
 */
export function generateLayoutMarkdown(layout: StructLayout): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportHtml = true;

  md.appendMarkdown(`### Memory Layout: \`${layout.name}\`\n\n`);
  md.appendMarkdown(`- **Total Size**: \`${layout.totalSize} bytes\`\n`);
  md.appendMarkdown(`- **Alignment**: \`${layout.alignment} bytes\`\n`);
  md.appendMarkdown(`- **Padding Overhead**: \`${layout.paddingBytes} bytes\` (${layout.totalSize > 0 ? Math.round((layout.paddingBytes / layout.totalSize) * 100) : 0}%)\n`);
  md.appendMarkdown(`- **Cache Lines (64B)**: \`${layout.cacheLines}\` ${layout.cacheLines > 1 ? '[Warning: Straddles multiple cache lines]' : '[Fits in 1 cache line]'}\n\n`);

  md.appendMarkdown('| Offset | Size | Field | Type |\n');
  md.appendMarkdown('| :--- | :--- | :--- | :--- |\n');

  for (const f of layout.fields) {
    if (f.isPadding) {
      md.appendMarkdown(`| \`+${f.offset}\` | \`${f.size}B\` | *padding* ░░ | — |\n`);
    } else {
      md.appendMarkdown(`| \`+${f.offset}\` | \`${f.size}B\` | **\`${f.name}\`** | \`${f.type}\` |\n`);
    }
  }

  if (layout.recommendation) {
    md.appendMarkdown(`\n> **Optimization Tip**: ${layout.recommendation}\n`);
  }

  return md;
}

/**
 * Parses struct or class definitions from C++ source code text at the cursor.
 */
function getActivePragmaPack(textBefore: string): number | undefined {
  const packRegex = /#pragma\s+pack\s*\(([^)]*)\)/g;
  const stack: (number | undefined)[] = [];
  let currentPack: number | undefined = undefined;

  let m: RegExpExecArray | null;
  while ((m = packRegex.exec(textBefore)) !== null) {
    const arg = m[1].trim();
    if (!arg) {
      // #pragma pack() resets to default
      currentPack = undefined;
    } else if (arg.startsWith('push')) {
      stack.push(currentPack);
      const parts = arg.split(',');
      if (parts.length > 1) {
        const n = parseInt(parts[1].trim(), 10);
        if (!isNaN(n)) currentPack = n;
      }
    } else if (arg.startsWith('pop')) {
      currentPack = stack.pop();
    } else {
      const n = parseInt(arg, 10);
      currentPack = !isNaN(n) ? n : undefined;
    }
  }

  return currentPack;
}

export interface ParsedStruct {
  name: string;
  isPacked: boolean;
  maxPackAlignment?: number;
  structAlignment?: number;
  fields: { type: string; name: string }[];
}

/**
 * Finds the index of the matching closing brace '}' for the open brace at openIndex.
 * Correctly skips string literals, character literals, and line/block comments.
 */
export function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 1;
  let inString = false;
  let inChar = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '/' && prev === '*') inBlockComment = false;
      continue;
    }
    if (inString) {
      if (ch === '"' && prev !== '\\') inString = false;
      continue;
    }
    if (inChar) {
      if (ch === '\'' && prev !== '\\') inChar = false;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '\'') {
      inChar = true;
      continue;
    }

    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Parses struct fields from the body text between braces.
 */
export function parseFieldsFromBody(body: string): { type: string; name: string }[] {
  const fields: { type: string; name: string }[] = [];

  // 1. Strip block comments and line comments
  let cleanBody = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  // 2. Strip member methods with braces: e.g. void reset() { ... }
  let methodIdx: number;
  while ((methodIdx = cleanBody.search(/\([^)]*\)[^{;]*\{/)) !== -1) {
    const openBrace = cleanBody.indexOf('{', methodIdx);
    const closeBrace = findMatchingBrace(cleanBody, openBrace);
    if (closeBrace !== -1) {
      const prevSemi = cleanBody.lastIndexOf(';', methodIdx);
      const start = prevSemi === -1 ? 0 : prevSemi + 1;
      cleanBody = cleanBody.substring(0, start) + cleanBody.substring(closeBrace + 1);
    } else {
      break;
    }
  }

  // 3. Strip access specifiers (public:, private:, protected:)
  cleanBody = cleanBody.replace(/\b(?:public|protected|private)\s*:/g, '');

  // 4. Split statements by semicolon
  const lines = cleanBody.split(';');

  for (const line of lines) {
    let clean = line.trim();
    if (!clean) continue;

    // Skip declarations with parentheses (e.g. member function declarations, macros)
    if (clean.includes('(')) continue;

    // Skip static members or friend declarations
    if (clean.startsWith('static ') || clean.startsWith('friend ')) continue;

    // Strip default initializers: e.g. "double value = 0.0" -> "double value"
    clean = clean.split('=')[0].trim();
    // Strip uniform initializers: e.g. "int flags{0}" -> "int flags"
    clean = clean.replace(/\{[^}]*\}$/, '').trim();

    // Strip C++ attributes like [[no_unique_address]] or alignas(...)
    clean = clean.replace(/\[\[[^\]]*\]\]/g, '').replace(/alignas\s*\([^)]*\)/g, '').trim();

    const memberMatch = clean.match(/^([\w:*&<>]+(?:\s+[\w:*&<>]+)*)\s+([a-zA-Z_]\w*)((?:\[\d+\])+)?$/);
    if (memberMatch) {
      const baseType = memberMatch[1].trim();
      const name = memberMatch[2].trim();
      const arraySuffix = memberMatch[3] ? memberMatch[3].trim() : '';
      fields.push({ type: baseType + arraySuffix, name });
    }
  }

  return fields;
}

export function extractStructFromRange(
  text: string,
  startIndex: number,
  openBraceIndex: number,
  closeBraceIndex: number,
  structName: string
): ParsedStruct {
  const body = text.substring(openBraceIndex + 1, closeBraceIndex);
  const textBefore = text.substring(0, startIndex);
  const structText = text.substring(startIndex, closeBraceIndex + 1);

  const activePack = getActivePragmaPack(textBefore);
  const hasPackedAttr = /__attribute__\s*\(\s*\(\s*packed\s*\)\s*\)/.test(structText);
  const isPacked = hasPackedAttr || (activePack !== undefined && activePack <= 1);
  const maxPackAlignment = activePack;

  const headerText = structText.substring(0, openBraceIndex - startIndex);
  const alignMatch = headerText.match(/alignas\s*\(\s*(\d+)\s*\)/);
  const structAlignment = alignMatch ? parseInt(alignMatch[1], 10) : undefined;

  const fields = parseFieldsFromBody(body);
  return { name: structName, isPacked, maxPackAlignment, structAlignment, fields };
}

export interface StructDefinitionLocation {
  parsed: ParsedStruct;
  startIndex: number;
  endIndex: number;
}

/**
 * Parses struct, class, or union definition at the exact cursor offset in the document text.
 */
export function extractStructDefinitionAtPosition(
  text: string,
  cursorOffset: number
): StructDefinitionLocation | null {
  const declRegex = /(?:template\s*<[^{;]*>\s*)?(?:struct|class|union)\b(?:\s+(?:alignas\s*\([^)]*\)|\[\[[^\]]*\]\]))*\s+([a-zA-Z_]\w*)\b[^{;]*\{/g;
  let match: RegExpExecArray | null;

  while ((match = declRegex.exec(text)) !== null) {
    const startIndex = match.index;
    const openBraceIndex = match.index + match[0].length - 1;
    const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
    if (closeBraceIndex === -1) continue;

    if (cursorOffset >= startIndex && cursorOffset <= closeBraceIndex + 1) {
      const structName = match[1];
      const parsed = extractStructFromRange(text, startIndex, openBraceIndex, closeBraceIndex, structName);
      return {
        parsed,
        startIndex,
        endIndex: closeBraceIndex + 1
      };
    }
  }

  return null;
}

export function extractStructAtPosition(
  text: string,
  cursorOffset: number
): ParsedStruct | null {
  const found = extractStructDefinitionAtPosition(text, cursorOffset);
  return found ? found.parsed : null;
}

/**
 * Searches for a struct, class, or union definition with matching name in the document text.
 */
export function findStructDefinitionInText(
  text: string,
  name: string
): StructDefinitionLocation | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declRegex = new RegExp(
    `(?:template\\s*<[^{;]*>\\s*)?(?:struct|class|union)\\b(?:\\s+(?:alignas\\s*\\([^)]*\\)|\\[\\[[^\\]]*\\]\\]))*\\s+${escapedName}\\b[^{;]*\\{`,
    'g'
  );
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(text)) !== null) {
    const startIndex = match.index;
    const openBraceIndex = match.index + match[0].length - 1;
    const closeBraceIndex = findMatchingBrace(text, openBraceIndex);
    if (closeBraceIndex === -1) continue;

    const parsed = extractStructFromRange(text, startIndex, openBraceIndex, closeBraceIndex, name);
    return {
      parsed,
      startIndex,
      endIndex: closeBraceIndex + 1
    };
  }

  return null;
}

export function findStructByName(
  text: string,
  name: string
): ParsedStruct | null {
  const found = findStructDefinitionInText(text, name);
  return found ? found.parsed : null;
}

/**
 * Converts a 0-based character offset to a VS Code Position.
 */
export function offsetToPosition(text: string, offset: number): vscode.Position {
  const sub = text.substring(0, offset);
  const lines = sub.split(/\r?\n/);
  const line = lines.length - 1;
  const character = lines[lines.length - 1].length;
  return new vscode.Position(line, character);
}

export function getRangeFromOffsets(
  doc: vscode.TextDocument,
  text: string,
  startIndex: number,
  endIndex: number
): vscode.Range {
  if (typeof doc.positionAt === 'function') {
    return new vscode.Range(doc.positionAt(startIndex), doc.positionAt(endIndex));
  }
  return new vscode.Range(offsetToPosition(text, startIndex), offsetToPosition(text, endIndex));
}

export interface HeaderStructMatch {
  parsed: ParsedStruct;
  uri: vscode.Uri;
  range: vscode.Range;
  document?: vscode.TextDocument;
}

/**
 * Recursively scans #include directives in a document to locate a struct/class definition.
 */
export async function searchIncludesForStruct(
  content: string,
  docUri: vscode.Uri,
  structName: string,
  visited: Set<string>,
  depth: number = 0,
  maxDepth: number = 3,
  extraIncludeDirs?: string[]
): Promise<HeaderStructMatch | null> {
  if (depth >= maxDepth) return null;

  const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const includeRegex = /#\s*include\s*["<]([^">]+)[">]/g;
  const includeMatches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = includeRegex.exec(cleanContent)) !== null) {
    includeMatches.push(m[1].trim());
  }

  const workspaceFolders = vscode.workspace.workspaceFolders?.map(wf => wf.uri.fsPath) || [];

  for (const rawInc of includeMatches) {
    const resolvedPath = resolveLocalHeaderPath(rawInc, docUri, undefined, extraIncludeDirs ?? workspaceFolders);
    if (!resolvedPath) continue;

    const normalized = canonicalizePath(resolvedPath);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    let headerText = '';
    let headerDoc: vscode.TextDocument | undefined = undefined;
    try {
      headerDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedPath));
      headerText = headerDoc.getText();
    } catch {
      try {
        if (fs.existsSync(resolvedPath)) {
          headerText = fs.readFileSync(resolvedPath, 'utf-8');
        }
      } catch {
        continue;
      }
    }

    if (!headerText) continue;

    const found = findStructDefinitionInText(headerText, structName);
    if (found && found.parsed.fields.length > 0) {
      const headerUri = vscode.Uri.file(resolvedPath);
      const range = headerDoc
        ? getRangeFromOffsets(headerDoc, headerText, found.startIndex, found.endIndex)
        : new vscode.Range(
            offsetToPosition(headerText, found.startIndex),
            offsetToPosition(headerText, found.endIndex)
          );
      return {
        parsed: found.parsed,
        uri: headerUri,
        range,
        document: headerDoc
      };
    }

    // Recurse into this header's includes
    const subMatch = await searchIncludesForStruct(
      headerText,
      vscode.Uri.file(resolvedPath),
      structName,
      visited,
      depth + 1,
      maxDepth,
      extraIncludeDirs
    );
    if (subMatch) {
      return subMatch;
    }
  }

  return null;
}

export interface ResolvedStructDefinition {
  parsed: ParsedStruct;
  documentUri: vscode.Uri;
  range?: vscode.Range;
  layout: StructLayout;
  definitionDocument?: vscode.TextDocument;
}

/**
 * Resolves the struct / class definition and memory layout across active document,
 * definition provider (LSP), #include directives, and workspace symbols.
 */
export async function resolveStructDefinition(
  document: vscode.TextDocument,
  position?: vscode.Position,
  structName?: string,
  extraIncludeDirs?: string[]
): Promise<ResolvedStructDefinition | null> {
  const dataModel: DataModel = process.platform === 'win32' ? 'LLP64' : 'LP64';
  const cleanName = structName ? structName.split('::').pop() || structName : undefined;

  // 1. Current document at cursor/position
  if (position) {
    try {
      const offset = document.offsetAt(position);
      const atPos = extractStructDefinitionAtPosition(document.getText(), offset);
      if (atPos && (!cleanName || atPos.parsed.name === cleanName) && atPos.parsed.fields.length > 0) {
        const layout = NativeBridge.calculateStructLayout(atPos.parsed.name, atPos.parsed.fields, {
          isPacked: atPos.parsed.isPacked,
          maxPackAlignment: atPos.parsed.maxPackAlignment,
          structAlignment: atPos.parsed.structAlignment,
          dataModel
        });
        const range = getRangeFromOffsets(document, document.getText(), atPos.startIndex, atPos.endIndex);
        return {
          parsed: atPos.parsed,
          documentUri: document.uri,
          range,
          layout,
          definitionDocument: document
        };
      }
    } catch {
      // Continue to next steps
    }
  }

  // 2. In current document by name
  if (cleanName) {
    try {
      const inDoc = findStructDefinitionInText(document.getText(), cleanName);
      if (inDoc && inDoc.parsed.fields.length > 0) {
        const layout = NativeBridge.calculateStructLayout(inDoc.parsed.name, inDoc.parsed.fields, {
          isPacked: inDoc.parsed.isPacked,
          maxPackAlignment: inDoc.parsed.maxPackAlignment,
          structAlignment: inDoc.parsed.structAlignment,
          dataModel
        });
        const range = getRangeFromOffsets(document, document.getText(), inDoc.startIndex, inDoc.endIndex);
        return {
          parsed: inDoc.parsed,
          documentUri: document.uri,
          range,
          layout,
          definitionDocument: document
        };
      }
    } catch {
      // Continue to next steps
    }
  }

  // 3. Via vscode.executeDefinitionProvider across definitions
  if (position) {
    try {
      const defs = await vscode.commands.executeCommand<vscode.LocationLink[] | vscode.Location[]>(
        'vscode.executeDefinitionProvider',
        document.uri,
        position
      );
      if (Array.isArray(defs) && defs.length > 0) {
        for (const target of defs) {
          const targetUri = 'targetUri' in target ? (target as vscode.LocationLink).targetUri : (target as vscode.Location).uri;
          const targetRange = 'targetRange' in target ? (target as vscode.LocationLink).targetRange : (target as vscode.Location).range;
          if (!targetUri) continue;

          let defDoc: vscode.TextDocument | null = null;
          if (targetUri.toString() === document.uri.toString()) {
            defDoc = document;
          } else {
            try {
              defDoc = await vscode.workspace.openTextDocument(targetUri);
            } catch {
              defDoc = null;
            }
          }

          if (defDoc) {
            const defText = defDoc.getText();
            // Check at offset if targetRange exists
            if (targetRange) {
              const defOffset = defDoc.offsetAt(targetRange.start);
              const atDef = extractStructDefinitionAtPosition(defText, defOffset);
              if (atDef && (!cleanName || atDef.parsed.name === cleanName) && atDef.parsed.fields.length > 0) {
                const layout = NativeBridge.calculateStructLayout(atDef.parsed.name, atDef.parsed.fields, {
                  isPacked: atDef.parsed.isPacked,
                  maxPackAlignment: atDef.parsed.maxPackAlignment,
                  structAlignment: atDef.parsed.structAlignment,
                  dataModel
                });
                const range = getRangeFromOffsets(defDoc, defText, atDef.startIndex, atDef.endIndex);
                return {
                  parsed: atDef.parsed,
                  documentUri: defDoc.uri,
                  range,
                  layout,
                  definitionDocument: defDoc
                };
              }
            }

            // Also check by name in defDoc
            if (cleanName) {
              const byName = findStructDefinitionInText(defText, cleanName);
              if (byName && byName.parsed.fields.length > 0) {
                const layout = NativeBridge.calculateStructLayout(byName.parsed.name, byName.parsed.fields, {
                  isPacked: byName.parsed.isPacked,
                  maxPackAlignment: byName.parsed.maxPackAlignment,
                  structAlignment: byName.parsed.structAlignment,
                  dataModel
                });
                const range = getRangeFromOffsets(defDoc, defText, byName.startIndex, byName.endIndex);
                return {
                  parsed: byName.parsed,
                  documentUri: defDoc.uri,
                  range,
                  layout,
                  definitionDocument: defDoc
                };
              }
            }
          }
        }
      }
    } catch {
      // Continue to next steps
    }
  }

  // 4. Via #include directives in document (recursive/transitive)
  if (cleanName) {
    const visited = new Set<string>();
    if (document.uri && document.uri.fsPath) {
      visited.add(canonicalizePath(document.uri.fsPath));
    }

    const includeMatch = await searchIncludesForStruct(
      document.getText(),
      document.uri,
      cleanName,
      visited,
      0,
      3,
      extraIncludeDirs
    );

    if (includeMatch) {
      const layout = NativeBridge.calculateStructLayout(includeMatch.parsed.name, includeMatch.parsed.fields, {
        isPacked: includeMatch.parsed.isPacked,
        maxPackAlignment: includeMatch.parsed.maxPackAlignment,
        structAlignment: includeMatch.parsed.structAlignment,
        dataModel
      });
      return {
        parsed: includeMatch.parsed,
        documentUri: includeMatch.uri,
        range: includeMatch.range,
        layout,
        definitionDocument: includeMatch.document
      };
    }
  }

  // 5. Workspace symbol search as final fallback
  if (cleanName) {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        cleanName
      );
      if (Array.isArray(symbols) && symbols.length > 0) {
        for (const sym of symbols) {
          if (
            (sym.kind === vscode.SymbolKind.Struct || sym.kind === vscode.SymbolKind.Class) &&
            sym.name === cleanName &&
            sym.location &&
            sym.location.uri
          ) {
            try {
              const symDoc = await vscode.workspace.openTextDocument(sym.location.uri);
              if (symDoc) {
                const symText = symDoc.getText();
                const byName = findStructDefinitionInText(symText, cleanName);
                if (byName && byName.parsed.fields.length > 0) {
                  const layout = NativeBridge.calculateStructLayout(byName.parsed.name, byName.parsed.fields, {
                    isPacked: byName.parsed.isPacked,
                    maxPackAlignment: byName.parsed.maxPackAlignment,
                    structAlignment: byName.parsed.structAlignment,
                    dataModel
                  });
                  const range = getRangeFromOffsets(symDoc, symText, byName.startIndex, byName.endIndex);
                  return {
                    parsed: byName.parsed,
                    documentUri: symDoc.uri,
                    range,
                    layout,
                    definitionDocument: symDoc
                  };
                }
              }
            } catch {
              // Continue checking other symbols
            }
          }
        }
      }
    } catch {
      // Ignore symbol search errors
    }
  }

  return null;
}

/**
 * VS Code Command Handler and Provider for Memory Layout Inspection.
 */
export class MemoryLayoutInspector implements vscode.Disposable {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('C/C++ Pro: Memory Layout');
  }

  public dispose(): void {
    this.outputChannel.dispose();
  }

  public async inspectCurrentStruct(
    editorOrArgs?: vscode.TextEditor | unknown,
    line?: number,
    character?: number,
    structName?: string
  ): Promise<StructLayout | null> {
    let targetUri: vscode.Uri | undefined;
    let targetPosition: vscode.Position | undefined;
    let targetStructName: string | undefined = structName;
    let editor: vscode.TextEditor | undefined;

    // 1. Check if passed a TextEditor instance
    if (editorOrArgs && typeof editorOrArgs === 'object' && 'document' in (editorOrArgs as Record<string, unknown>)) {
      editor = editorOrArgs as vscode.TextEditor;
    } else if (Array.isArray(editorOrArgs) && editorOrArgs.length >= 3) {
      // 2. Encoded array [uriStr, line, char, structName?]
      const uriStr = editorOrArgs[0];
      targetUri = typeof uriStr === 'string' ? vscode.Uri.parse(uriStr) : (uriStr instanceof vscode.Uri ? uriStr : undefined);
      targetPosition = new vscode.Position(Number(editorOrArgs[1]), Number(editorOrArgs[2]));
      if (editorOrArgs.length > 3 && editorOrArgs[3]) {
        targetStructName = String(editorOrArgs[3]);
      }
    } else if (typeof editorOrArgs === 'string') {
      // 3. URI string argument
      targetUri = vscode.Uri.parse(editorOrArgs);
      if (typeof line === 'number' && typeof character === 'number') {
        targetPosition = new vscode.Position(line, character);
      }
    } else if (editorOrArgs && typeof editorOrArgs === 'object') {
      // 4. Object argument { uri/documentUri, line/character/position, structName }
      const obj = editorOrArgs as Record<string, unknown>;
      const rawUri = (obj['documentUri'] ?? obj['uri']) as string | vscode.Uri | undefined;
      if (rawUri) {
        targetUri = typeof rawUri === 'string' ? vscode.Uri.parse(rawUri) : (rawUri instanceof vscode.Uri ? rawUri : undefined);
      }
      const rawPos = obj['position'];
      if (rawPos instanceof vscode.Position) {
        targetPosition = rawPos;
      } else if (typeof obj['line'] === 'number' && typeof obj['character'] === 'number') {
        targetPosition = new vscode.Position(obj['line'], obj['character']);
      }
      if (typeof obj['structName'] === 'string') {
        targetStructName = obj['structName'];
      }
    }

    // Determine target document and editor
    let doc: vscode.TextDocument | undefined = editor?.document;
    if (targetUri && (!doc || doc.uri.toString() !== targetUri.toString())) {
      try {
        doc = await vscode.workspace.openTextDocument(targetUri);
      } catch {
        // Fall back to active editor
      }
    }

    if (!doc) {
      editor = vscode.window.activeTextEditor;
      doc = editor?.document;
    }

    if (!doc) {
      vscode.window.showWarningMessage('C/C++ Pro: No active C/C++ editor.');
      return null;
    }

    const pos = targetPosition || editor?.selection.active;

    // Extract identifier at position if struct name not explicitly passed
    if (!targetStructName && pos && doc) {
      const wordRange = doc.getWordRangeAtPosition(pos);
      if (wordRange) {
        const word = doc.getText(wordRange).trim();
        if (/^[a-zA-Z_]\w*$/.test(word)) {
          targetStructName = word;
        }
      }
    }

    // Resolve struct definition across current doc, definitions, headers, and workspace
    const resolved = await resolveStructDefinition(doc, pos, targetStructName);

    if (resolved) {
      // Navigate to definition file and reveal range
      try {
        const targetDoc = resolved.definitionDocument || await vscode.workspace.openTextDocument(resolved.documentUri);
        const revealedEditor = await vscode.window.showTextDocument(targetDoc, {
          preview: false,
          selection: resolved.range
        });
        if (resolved.range && revealedEditor && typeof revealedEditor.revealRange === 'function') {
          revealedEditor.revealRange(resolved.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
      } catch {
        // Continue showing diagram even if navigation throws in headless mode
      }

      const diagram = generateLayoutAsciiDiagram(resolved.layout);
      this.outputChannel.clear();
      this.outputChannel.appendLine(diagram);
      this.outputChannel.show(true);

      return resolved.layout;
    }

    if (targetStructName) {
      vscode.window.showWarningMessage(
        `C/C++ Pro: Definition for '${targetStructName}' could not be found. Did you mean to create one?`
      );
    } else {
      vscode.window.showInformationMessage(
        'C/C++ Pro: Place cursor inside a struct or class to inspect memory layout.'
      );
    }

    return null;
  }
}
