import * as vscode from 'vscode';
import { findStlDocumentation, findStlDocumentationAsync, StlDocEntry } from './stl-knowledge-base';
import { TypedefProvider } from './typedef-provider';
import {
  extractStructAtPosition,
  findStructByName,
  calculateStructLayout,
  resolveStructDefinition,
  StructLayout,
  DataModel
} from '../inspector/memory-layout-inspector';
import { NativeBridge } from '../native/native-bridge';
import { makeFindReferencesLink, makeInspectMemoryLayoutLink } from './command-links';
export { makeFindReferencesLink, makeInspectMemoryLayoutLink } from './command-links';

export interface ParameterInfo {
  name: string;
  type: string;
  semantics: string;
  description?: string;
}

export interface ParsedFunctionSignature {
  isFunction: boolean;
  name: string;
  scope?: string;
  returnType: string;
  templateClause?: string;
  requiresClause?: string;
  isSpecialization?: boolean;
  instantiationArgs?: string[];
  parameters: ParameterInfo[];
  badges: string[];
}

/**
 * Analyzes C++ type strings to deduce memory and value transfer semantics.
 */
export function inferParameterSemantics(paramType: string): string {
  const trimmed = paramType.trim();

  if (trimmed.includes('unique_ptr')) {
    return 'Exclusive Ownership (Heap)';
  }
  if (trimmed.includes('shared_ptr')) {
    return 'Shared Ownership (Refcounted)';
  }
  if (trimmed.includes('string_view') || trimmed.includes('span')) {
    return 'Non-Owning View (Zero-Copy)';
  }
  if (trimmed.startsWith('const ') && trimmed.endsWith('&')) {
    return 'Read-Only (Const Ref)';
  }
  if (trimmed.endsWith('&&')) {
    return 'Move / Sink (Rvalue Ref)';
  }
  if (trimmed.endsWith('&')) {
    return 'Mutable (In-Out Ref)';
  }
  if (trimmed.startsWith('const ') && trimmed.endsWith('*')) {
    return 'Read-Only (Const Ptr)';
  }
  if (trimmed.endsWith('*')) {
    return 'Pointer (Nullable / In-Out)';
  }

  const primitives = [
    'int',
    'float',
    'double',
    'char',
    'bool',
    'size_t',
    'uint32_t',
    'int32_t',
    'uint64_t',
    'int64_t',
    'short',
    'long'
  ];
  if (primitives.includes(trimmed)) {
    return 'By-Value (Primitive Copy)';
  }

  return 'By-Value (Copy)';
}

/**
 * Strips compiler internal ugly prefixes (MSVC _Ty, _Args, GCC __first) into clean C++ names.
 */
export function deuglifyIdentifier(name: string): string {
  if (!name) return name;
  const trimmed = name.trim();
  const knownMap: Record<string, string> = {
    _Ty: 'T',
    _Type: 'T',
    _Types: 'Types',
    _Args: 'args',
    _Val: 'value',
    _Elem: 'element',
    _Fn: 'fn',
    _Func: 'fn',
    _Pred: 'pred',
    _Count: 'count',
    _Size: 'size',
    _Left: 'left',
    _Right: 'right',
    _Key: 'key',
    _Alloc: 'alloc'
  };

  if (knownMap[trimmed]) {
    return knownMap[trimmed];
  }

  if (trimmed.startsWith('__')) {
    return trimmed.substring(2);
  }

  if (/^_[A-Z]/.test(trimmed)) {
    return trimmed.substring(1, 2).toLowerCase() + trimmed.substring(2);
  }

  return trimmed;
}

/**
 * Cleans template instantiation arguments by removing internal SFINAE constants (0, nullptr)
 * and unwrapping nested pack brackets (<double> -> double).
 */
export function cleanInstantiationArgs(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  const parts = splitParameters(raw);
  const cleaned: string[] = [];

  for (const p of parts) {
    let item = p.trim();
    // Filter out compiler internal SFINAE non-type tags (e.g. 0, 1, nullptr, false)
    if (/^(0|1|nullptr|false|true)$/.test(item)) {
      continue;
    }
    // Unwrap angle brackets if wrapped, e.g. <double> -> double
    if (item.startsWith('<') && item.endsWith('>')) {
      item = item.substring(1, item.length - 1).trim();
    }
    if (item) {
      cleaned.push(item);
    }
  }

  return cleaned;
}

/**
 * Splits a code string on whitespace, while respecting angle (<...>),
 * parenthesis ((...)), and square bracket ([...]) nesting.
 */
export function tokenizeTopLevel(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let angleDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '<') {
      angleDepth++;
    } else if (ch === '>') {
      if (angleDepth > 0) angleDepth--;
    } else if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      if (parenDepth > 0) parenDepth--;
    } else if (ch === '[') {
      bracketDepth++;
    } else if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--;
    }

    const isWhitespace = /\s/.test(ch);
    if (isWhitespace && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim().length > 0) {
        tokens.push(current.trim());
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.trim().length > 0) {
    tokens.push(current.trim());
  }

  return tokens;
}

/**
 * Splits parameter string by comma, respecting template angle brackets and parens.
 */
export function splitParameters(content: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '>' || ch === ')' || ch === '}' || ch === ']') {
      if (depth > 0) depth--;
    } else if (ch === ',' && depth === 0) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) {
    result.push(current.trim());
  }
  return result;
}

/**
 * Parses raw C++ function signatures extracted from Clangd hover blocks.
 */
export function parseSignature(code: string): ParsedFunctionSignature | null {
  const normalized = code.replace(/\r\n/g, '\n').trim();

  // Check if it represents a function or method
  if (!normalized.includes('(') || !normalized.includes(')')) {
    return null;
  }

  // 1. Extract scope comment if emitted by Clangd (e.g. "// In namespace std" or "// In class geometry::Cube")
  let scope: string | undefined;
  const scopeMatch = normalized.match(/^\/\/\s*In\s+(?:namespace|class|struct)\s+([a-zA-Z0-9_:<> ]+)/m);
  if (scopeMatch) {
    scope = scopeMatch[1].trim();
  }

  // 2. Strip comment lines
  const codeWithoutComments = normalized
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .trim();

  // 3. Badges detection
  const badges: string[] = [];

  if (codeWithoutComments.includes('noexcept')) {
    badges.push('noexcept');
  }
  if (codeWithoutComments.includes('[[nodiscard]]')) {
    badges.push('[[nodiscard]]');
  }
  if (codeWithoutComments.includes('constexpr')) {
    badges.push('constexpr');
  }
  if (codeWithoutComments.includes('consteval')) {
    badges.push('consteval');
  }
  if (codeWithoutComments.includes('explicit')) {
    badges.push('explicit');
  }
  if (codeWithoutComments.includes('inline')) {
    badges.push('inline');
  }
  if (codeWithoutComments.includes('override')) {
    badges.push('override');
  }
  if (codeWithoutComments.includes('= 0')) {
    badges.push('pure virtual');
  } else if (codeWithoutComments.includes('virtual')) {
    badges.push('virtual');
  }
  if (
    (scope && scope.startsWith('std')) ||
    codeWithoutComments.includes('std::') ||
    codeWithoutComments.includes('__gnu_cxx') ||
    /\b(printf|malloc|free|memcpy|memset|fopen|fclose)\b/.test(codeWithoutComments)
  ) {
    badges.push('Standard Library');
  }

  // 4. Template clause extraction
  const isSpecialization = /template\s*<\s*>/.test(codeWithoutComments);
  let templateClause: string | undefined;
  const templateMatch = codeWithoutComments.match(/template\s*<([^>]+)>/);
  if (templateMatch && !isSpecialization) {
    templateClause = templateMatch[1].trim();
  }

  // 5. Requires clause extraction
  let requiresClause: string | undefined;
  const requiresMatch = codeWithoutComments.match(/requires\s+([^\n(]+)(?:\n|\()/);
  if (requiresMatch) {
    requiresClause = requiresMatch[1].trim();
  }

  // 6. Extract parameter block between outermost matching parentheses
  const firstParen = codeWithoutComments.indexOf('(');
  const lastParen = codeWithoutComments.lastIndexOf(')');
  if (firstParen === -1 || lastParen === -1 || lastParen <= firstParen) {
    return null;
  }

  let beforeParen = codeWithoutComments.substring(0, firstParen).trim();
  const parenContent = codeWithoutComments.substring(firstParen + 1, lastParen).trim();
  const afterParen = codeWithoutComments.substring(lastParen + 1).trim();

  // Strip template clause from beforeParen
  if (beforeParen.startsWith('template')) {
    const angleStart = beforeParen.indexOf('<');
    if (angleStart !== -1) {
      let d = 0;
      let endIdx = -1;
      for (let i = angleStart; i < beforeParen.length; i++) {
        if (beforeParen[i] === '<') d++;
        else if (beforeParen[i] === '>') {
          d--;
          if (d === 0) {
            endIdx = i;
            break;
          }
        }
      }
      if (endIdx !== -1) {
        beforeParen = beforeParen.substring(endIdx + 1).trim();
      }
    }
  }

  // Strip requires clause from beforeParen
  if (beforeParen.startsWith('requires')) {
    const newlineIdx = beforeParen.indexOf('\n');
    if (newlineIdx !== -1) {
      beforeParen = beforeParen.substring(newlineIdx + 1).trim();
    } else if (requiresClause) {
      beforeParen = beforeParen.replace(`requires ${requiresClause}`, '').trim();
    }
  }

  // 7. Tokenize preamble before parens respecting bracket balancing
  const tokens = tokenizeTopLevel(beforeParen);
  if (tokens.length === 0) {
    return null;
  }

  const funcToken = tokens[tokens.length - 1];
  let funcName = funcToken;
  let instantiationArgs: string[] | undefined;

  if (funcToken.includes('<') && funcToken.endsWith('>')) {
    const firstAngle = funcToken.indexOf('<');
    const rawInst = funcToken.substring(firstAngle + 1, funcToken.length - 1);
    funcName = funcToken.substring(0, firstAngle);
    instantiationArgs = cleanInstantiationArgs(rawInst);
  }

  funcName = funcName.replace(/^[*&]+/, '');

  // Determine return type
  let returnType = 'void';
  const trailingArrowMatch = afterParen.match(/->\s*([a-zA-Z0-9_:<>*& ]+)/);
  if (trailingArrowMatch) {
    returnType = trailingArrowMatch[1].trim();
  } else if (tokens.length > 1) {
    const retTokens = tokens.slice(0, tokens.length - 1);
    const filtered = retTokens.filter(
      (t) => !['virtual', 'explicit', 'inline', 'constexpr', 'consteval', 'friend', 'static'].includes(t)
    );
    returnType = filtered.join(' ').trim();
    if (!returnType) {
      returnType = 'auto';
    }
  }

  // 8. Parse parameter list
  const parameters: ParameterInfo[] = [];
  if (parenContent.length > 0) {
    const rawParams = splitParameters(parenContent);
    for (const raw of rawParams) {
      const trimmedParam = raw.trim();
      if (!trimmedParam || trimmedParam === 'void') continue;

      let paramName = '';
      let paramType = trimmedParam;

      // Handle default values: int x = 10
      const eqIdx = trimmedParam.indexOf('=');
      if (eqIdx !== -1) {
        paramType = trimmedParam.substring(0, eqIdx).trim();
      }

      const pTokens = paramType.split(/\s+/);
      if (pTokens.length > 1) {
        paramName = pTokens[pTokens.length - 1];
        if (paramName.startsWith('*') || paramName.startsWith('&')) {
          paramName = paramName.replace(/^[*&]+/, '');
        }
        paramType = paramType.substring(0, paramType.lastIndexOf(paramName)).trim();
      } else {
        paramName = `arg${parameters.length + 1}`;
      }

      // De-uglify compiler parameter identifiers
      paramName = deuglifyIdentifier(paramName);

      parameters.push({
        name: paramName,
        type: paramType,
        semantics: inferParameterSemantics(paramType)
      });
    }
  }

  return {
    isFunction: true,
    name: funcName,
    scope,
    returnType: returnType || 'auto',
    templateClause,
    requiresClause,
    isSpecialization,
    instantiationArgs,
    parameters,
    badges
  };
}

export { parseDoxygen, DoxygenParsedDoc } from './doxygen-parser';
import { parseDoxygen } from './doxygen-parser';

/**
 * Transforms standard Clangd hovers into rich, rust-analyzer style developer cards.
 */
export class HoverTransformer {
  public static extractHoverPayload(hover: vscode.Hover): { codeBlock: string; docText: string } {
    let codeBlock = '';
    let docText = '';

    for (const part of hover.contents) {
      const str = typeof part === 'string' ? part : (part as vscode.MarkdownString).value;
      if (str.includes('```cpp') || str.includes('```c')) {
        const match = str.match(/```(?:cpp|c)\n([\s\S]*?)\n```/);
        if (match) {
          codeBlock = match[1];
        } else {
          codeBlock = str;
        }
      } else if (str.trim().length > 0) {
        docText += (docText ? '\n\n' : '') + str.trim();
      }
    }

    return { codeBlock, docText };
  }

  /**
   * Transforms an incoming vscode.Hover from clangd into an enriched hover.
   */
  public static transform(
    hover: vscode.Hover,
    stlDocOverride?: StlDocEntry,
    hoveredWord?: string,
    structLayout?: StructLayout | null,
    documentUri?: vscode.Uri,
    position?: vscode.Position
  ): vscode.Hover {
    if (!hover || !hover.contents || hover.contents.length === 0) {
      return hover;
    }

    const { codeBlock, docText } = this.extractHoverPayload(hover);
    if (!codeBlock) {
      return hover;
    }

    const sig = parseSignature(codeBlock);
    if (!sig) {
      // 1. Check if this hover corresponds to a known or user-defined typedef / type alias
      const typedefHover = TypedefProvider.provideTypedefHover(codeBlock, hoveredWord, hover.range);
      if (typedefHover) {
        return typedefHover;
      }

      // Check if this type definition corresponds to a known STL type (e.g. std::vector, std::string)
      let typeStlDoc: StlDocEntry | null = stlDocOverride ?? null;
      if (!typeStlDoc) {
        const typeMatch = codeBlock.match(/(?:class|struct|using)\s+([A-Za-z0-9_:]+)/);
        if (typeMatch) {
          typeStlDoc = findStlDocumentation(typeMatch[1]);
        } else {
          const words = codeBlock.trim().split(/[\s<({]/);
          if (words[0]) {
            typeStlDoc = findStlDocumentation(words[0]);
          }
        }
      }

      if (typeStlDoc) {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`### \`${typeStlDoc.symbol}\` *(Standard Library)*\n\n`);
        md.appendMarkdown(
          `**Standard**: \`[Standard Library]\` \`[${typeStlDoc.header}]\` \`[${typeStlDoc.standard}]\`\n\n`
        );
        md.appendCodeblock(typeStlDoc.canonicalSignature, 'cpp');
        md.appendMarkdown(`${typeStlDoc.summary}\n\n`);

        if (typeStlDoc.complexity) {
          const timeBadge = `**Time**: \`${typeStlDoc.complexity.time}\``;
          const spaceBadge = typeStlDoc.complexity.space
            ? ` | **Space**: \`${typeStlDoc.complexity.space}\``
            : '';
          md.appendMarkdown(`**Complexity**: ${timeBadge}${spaceBadge}\n\n`);
        }

        if (typeStlDoc.exceptionSafety) {
          md.appendMarkdown(`**Exception Safety**: ${typeStlDoc.exceptionSafety}\n\n`);
        }

        if (typeStlDoc.invalidation) {
          md.appendMarkdown(`> **Iterator Invalidation**: ${typeStlDoc.invalidation}\n\n`);
        }

        if (typeStlDoc.example) {
          md.appendMarkdown('#### Example\n\n');
          md.appendCodeblock(typeStlDoc.example, 'cpp');
          md.appendMarkdown('\n');
        }

        if (typeStlDoc.seeAlso && typeStlDoc.seeAlso.length > 0) {
          const seeAlsoLinks = typeStlDoc.seeAlso.map((s) => `\`${s}\``).join(', ');
          md.appendMarkdown(`**See Also**: ${seeAlsoLinks}\n\n`);
        }

        md.appendMarkdown('---\n');
        const findRefLink = makeFindReferencesLink(documentUri, position);
        md.appendMarkdown(
          `[cppreference: ${typeStlDoc.symbol}](${typeStlDoc.docUrl}) | [Switch Header/Source](command:c-cpp-pro.switchSourceHeader) | ${findRefLink}`
        );
        return new vscode.Hover(md, hover.range);
      }

      // Clean declaration title: strip leading // In namespace/class comments or blank lines
      const cleanCode = codeBlock.replace(/^(?:\s*\/\/[^\n]*\r?\n)+/g, '').trim();
      const isStructOrClassDecl =
        /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union)\b/m.test(cleanCode);
      const isStructOrClass = isStructOrClassDecl || (structLayout !== null && structLayout !== undefined);

      if (isStructOrClass) {
        let layout = structLayout;
        const targetName = (hoveredWord || '').split('::').pop();

        if (layout && targetName && layout.name !== targetName && isStructOrClassDecl) {
          // If layout name does not match the hovered struct declaration, discard it
          layout = null;
        }

        if (!layout && codeBlock.includes('{') && codeBlock.includes('}')) {
          const openIdx = codeBlock.indexOf('{');
          const parsed =
            extractStructAtPosition(codeBlock, openIdx) ??
            (targetName ? findStructByName(codeBlock, targetName) : null);
          if (parsed && (!targetName || parsed.name === targetName) && parsed.fields.length > 0) {
            const dataModel: DataModel = process.platform === 'win32' ? 'LLP64' : 'LP64';
            try {
              layout = calculateStructLayout(parsed.name, parsed.fields, {
                isPacked: parsed.isPacked,
                maxPackAlignment: parsed.maxPackAlignment,
                structAlignment: parsed.structAlignment,
                dataModel
              });
            } catch {
              layout = null;
            }
          }
        }

        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        const declLine = cleanCode.split('{')[0].replace(/;+$/, '').trim();
        const namespaceMatch = codeBlock.match(/\/\/\s*In namespace\s+([A-Za-z0-9_:]+)/);
        const classMatch = codeBlock.match(/\/\/\s*In (?:class|struct)\s+([A-Za-z0-9_:]+)/);

        let nsBadge = ' *(Type Definition)*';
        if (namespaceMatch) {
          nsBadge = ` *(in namespace \`${namespaceMatch[1]}\`)*`;
        } else if (classMatch) {
          nsBadge = ` *(in \`${classMatch[1]}\`)*`;
        } else if (!isStructOrClassDecl) {
          nsBadge = ' *(Member Variable)*';
        }

        md.appendMarkdown(`### \`${declLine}\`${nsBadge}\n\n`);

        if (layout) {
          const overheadPct =
            layout.totalSize > 0
              ? Math.round((layout.paddingBytes / layout.totalSize) * 100)
              : 0;

          if (!isStructOrClassDecl) {
            md.appendMarkdown(`**Type Layout**: \`struct ${layout.name}\`\n\n`);
          }

          md.appendMarkdown(
            `**Size**: \`${layout.totalSize} bytes\` | **Alignment**: \`${layout.alignment} bytes\` | **Padding**: \`${layout.paddingBytes} bytes\` (${overheadPct}%)\n\n`
          );
          md.appendMarkdown(
            `- **Cache Footprint**: \`${layout.cacheLines} cache line${layout.cacheLines > 1 ? 's' : ''} (64B)\` ${layout.cacheLines > 1 ? '*(Warning: Straddles cache boundary)*' : '*(Fits in 1 cache line)*'}\n\n`
          );

          if (layout.fields.length > 0) {
            md.appendMarkdown('| Offset | Size | Field | Type |\n');
            md.appendMarkdown('| :--- | :--- | :--- | :--- |\n');
            for (const f of layout.fields) {
              if (f.isPadding) {
                md.appendMarkdown(`| \`+${f.offset}\` | \`${f.size}B\` | *padding* ░░ | — |\n`);
              } else {
                md.appendMarkdown(`| \`+${f.offset}\` | \`${f.size}B\` | **\`${f.name}\`** | \`${f.type}\` |\n`);
              }
            }
            md.appendMarkdown('\n');
          }

          if (layout.recommendation) {
            md.appendMarkdown(`> **Optimization Tip**: ${layout.recommendation}\n\n`);
          }
        } else {
          md.appendCodeblock(cleanCode || codeBlock, 'cpp');
        }

        if (docText) {
          md.appendMarkdown(`\n${docText}\n`);
        }

        md.appendMarkdown('\n---\n');
        const findRefLink = makeFindReferencesLink(documentUri, position);
        const structTarget = layout?.name || targetName;
        const inspectLink = makeInspectMemoryLayoutLink(documentUri, position, structTarget);
        md.appendMarkdown(
          `${inspectLink} | ${findRefLink} | [Switch Header/Source](command:c-cpp-pro.switchSourceHeader)`
        );
        return new vscode.Hover(md, hover.range);
      }
      return hover;
    }

    const doxygen = parseDoxygen(docText);

    // Attach descriptions to parameters from Doxygen if present
    for (const param of sig.parameters) {
      if (doxygen.params.has(param.name)) {
        param.description = doxygen.params.get(param.name);
      }
    }

    // Check if this is a standard library function recognized by the Curated STL Knowledge Base
    const stlDoc = stlDocOverride ?? findStlDocumentation(sig.name, sig.scope);

    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    if (stlDoc) {
      // --- Curated Standard Library Documentation Card ---
      md.appendMarkdown(`### \`${stlDoc.symbol}\` *(Standard Library)*\n\n`);

      // Badges: Standard Library, Header, ISO Standard, plus compiler specifiers
      const specifiers = sig.badges.filter(
        (b) => !['Standard Library'].includes(b)
      );
      const headerBadge = `\`[${stlDoc.header}]\``;
      const standardBadge = `\`[${stlDoc.standard}]\``;
      const specifierBadges = specifiers.map((s) => `\`[${s}]\``).join(' ');
      md.appendMarkdown(`**Standard**: \`[Standard Library]\` ${headerBadge} ${standardBadge}`);
      if (specifierBadges) {
        md.appendMarkdown(` | **Specifiers**: ${specifierBadges}`);
      }
      md.appendMarkdown('\n\n');

      // Canonical signature
      md.appendCodeblock(stlDoc.canonicalSignature, 'cpp');

      // Instantiation note
      if (sig.instantiationArgs && sig.instantiationArgs.length > 0) {
        let instText = '';
        if (sig.name === 'make_unique' || sig.name === 'make_shared') {
          const tType = sig.instantiationArgs[0];
          const argTypes = sig.instantiationArgs.slice(1);
          const argsStr = argTypes.length > 0 ? `Args = [${argTypes.join(', ')}]` : 'Args = []';
          instText = `T = ${tType}, ${argsStr}`;
        } else {
          instText = sig.instantiationArgs.join(', ');
        }
        md.appendMarkdown(`> **Instantiated for**: \`${instText}\`\n\n`);
      }

      // Summary description
      md.appendMarkdown(`${stlDoc.summary}\n\n`);

      // Complexity
      if (stlDoc.complexity) {
        const timeBadge = `**Time**: \`${stlDoc.complexity.time}\``;
        const spaceBadge = stlDoc.complexity.space
          ? ` | **Space**: \`${stlDoc.complexity.space}\``
          : '';
        md.appendMarkdown(`**Complexity**: ${timeBadge}${spaceBadge}\n\n`);
      }

      // Exception Safety
      if (stlDoc.exceptionSafety) {
        md.appendMarkdown(`**Exception Safety**: ${stlDoc.exceptionSafety}\n\n`);
      }

      // Iterator Invalidation
      if (stlDoc.invalidation) {
        md.appendMarkdown(`> **Iterator Invalidation**: ${stlDoc.invalidation}\n\n`);
      }

      // Parameters table with curated STL explanations
      if (sig.parameters.length > 0) {
        md.appendMarkdown('#### Parameters\n\n');
        md.appendMarkdown('| Parameter | Type | Semantics | Description |\n');
        md.appendMarkdown('| :--- | :--- | :--- | :--- |\n');
        for (const p of sig.parameters) {
          let desc = p.description || stlDoc.parameters[p.name];
          if (!desc) {
            if (stlDoc.parameters['args'] && (p.name === 'args' || p.name.startsWith('arg'))) {
              desc = stlDoc.parameters['args'];
            } else if (stlDoc.parameters['value'] && (p.name === 'value' || p.name === 'val')) {
              desc = stlDoc.parameters['value'];
            }
          }
          md.appendMarkdown(`| \`${p.name}\` | \`${p.type}\` | ${p.semantics} | ${desc || '-'} |\n`);
        }
        md.appendMarkdown('\n');
      }

      // Returns section
      const retDoc = stlDoc.returns ? ` - ${stlDoc.returns}` : '';
      md.appendMarkdown(`**Returns**: \`${sig.returnType}\`${retDoc}\n\n`);

      // Code example
      if (stlDoc.example) {
        md.appendMarkdown('#### Example\n\n');
        md.appendCodeblock(stlDoc.example, 'cpp');
        md.appendMarkdown('\n');
      }

      // See Also
      if (stlDoc.seeAlso && stlDoc.seeAlso.length > 0) {
        const seeAlsoLinks = stlDoc.seeAlso.map((s) => `\`${s}\``).join(', ');
        md.appendMarkdown(`**See Also**: ${seeAlsoLinks}\n\n`);
      }

      // Documentation & Action links
      md.appendMarkdown('---\n');
      const findRefLink = makeFindReferencesLink(documentUri, position);
      md.appendMarkdown(
        `[cppreference: ${stlDoc.symbol}](${stlDoc.docUrl}) | [Switch Header/Source](command:c-cpp-pro.switchSourceHeader) | ${findRefLink}`
      );
    } else {
      // --- User-Defined Function AST Card ---
      md.appendMarkdown(`### \`${sig.name}\` *(function)*\n\n`);
      md.appendCodeblock(codeBlock, 'cpp');

      // Badges line
      if (sig.badges.length > 0) {
        const badgeList = sig.badges.map((b) => `\`[${b}]\``).join(' ');
        md.appendMarkdown(`**Specifiers**: ${badgeList}\n\n`);
      }

      if (doxygen.deprecated) {
        md.appendMarkdown(`> **Deprecated**: ${doxygen.deprecated}\n\n`);
      }

      if (doxygen.warnings.length > 0) {
        for (const w of doxygen.warnings) {
          md.appendMarkdown(`> **Warning**: ${w}\n\n`);
        }
      }

      if (doxygen.notes.length > 0) {
        for (const n of doxygen.notes) {
          md.appendMarkdown(`> **Note**: ${n}\n\n`);
        }
      }

      // Brief description
      if (doxygen.brief) {
        md.appendMarkdown(`${doxygen.brief}\n\n`);
      }

      // Constraints and concepts
      if (sig.requiresClause || sig.templateClause) {
        md.appendMarkdown('#### Constraints & Concepts\n');
        if (sig.templateClause) {
          md.appendMarkdown(`- Template: \`<${sig.templateClause}>\`\n`);
        }
        if (sig.requiresClause) {
          md.appendMarkdown(`- Requires: \`${sig.requiresClause}\`\n`);
        }
        md.appendMarkdown('\n');
      }

      // Parameters table
      if (sig.parameters.length > 0) {
        md.appendMarkdown('#### Parameters\n\n');
        md.appendMarkdown('| Parameter | Type | Semantics | Description |\n');
        md.appendMarkdown('| :--- | :--- | :--- | :--- |\n');
        for (const p of sig.parameters) {
          const desc = p.description ? p.description : '-';
          md.appendMarkdown(`| \`${p.name}\` | \`${p.type}\` | ${p.semantics} | ${desc} |\n`);
        }
        md.appendMarkdown('\n');
      }

      // Returns section
      const retDoc = doxygen.returns ? ` - ${doxygen.returns}` : '';
      md.appendMarkdown(`**Returns**: \`${sig.returnType}\`${retDoc}\n\n`);

      if (doxygen.throws.length > 0) {
        md.appendMarkdown('#### Exceptions\n\n');
        for (const th of doxygen.throws) {
          md.appendMarkdown(`- ${th}\n`);
        }
        md.appendMarkdown('\n');
      }

      if (doxygen.see.length > 0) {
        md.appendMarkdown(`**See Also**: ${doxygen.see.join(', ')}\n\n`);
      }

      // Interactive Action Links
      md.appendMarkdown('---\n');
      const findRefLink = makeFindReferencesLink(documentUri, position);
      md.appendMarkdown(
        `[Switch Header/Source](command:c-cpp-pro.switchSourceHeader) | ${findRefLink} | [Open Docs (cppreference)](command:c-cpp-pro.openDocs)`
      );
    }

    return new vscode.Hover([md], hover.range);
  }

  /**
   * Asynchronously transforms an incoming vscode.Hover from clangd into an enriched hover,
   * querying both the local ISO C++ knowledge base and remote/system header providers,
   * and calculating struct/class memory layout and alignment.
   */
  public static async transformAsync(
    hover: vscode.Hover,
    hoveredWord?: string,
    document?: vscode.TextDocument,
    position?: vscode.Position
  ): Promise<vscode.Hover> {
    if (!hover || !hover.contents || hover.contents.length === 0) {
      return hover;
    }

    const { codeBlock } = this.extractHoverPayload(hover);
    if (!codeBlock) {
      return hover;
    }

    const sig = parseSignature(codeBlock);
    if (!sig) {
      // 1. Check if this hover corresponds to a known or user-defined typedef / type alias
      const typedefHover = TypedefProvider.provideTypedefHover(
        codeBlock,
        hoveredWord,
        hover.range,
        document?.uri,
        position
      );
      if (typedefHover) {
        return typedefHover;
      }

      // Strip leading comments to inspect the actual declaration code
      const cleanCode = codeBlock.replace(/^(?:\s*\/\/[^\n]*\r?\n)+/g, '').trim();

      let candidate = '';
      const declMatch = cleanCode.match(/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union)\s+([A-Za-z0-9_:]+)/m);
      if (declMatch) {
        candidate = declMatch[1];
      } else {
        const declLine = cleanCode.split(/[={;\n]/)[0].trim();
        const varMatch = declLine.match(/^([\w:*&<>\s]+?)\s*([a-zA-Z_]\w*)$/);
        if (varMatch) {
          candidate = varMatch[1]
            .replace(/^(?:const|volatile|constexpr|mutable)\s+/, '')
            .replace(/[*&\s]+$/, '')
            .trim();
        } else {
          const words = cleanCode.trim().split(/[\s<({]/);
          if (words[0]) {
            candidate = words[0];
          }
        }
      }

      if (candidate) {
        const doc = await findStlDocumentationAsync(candidate);
        if (doc) {
          return this.transform(hover, doc, hoveredWord, undefined, document?.uri, position);
        }
      }

      // Check if this is a struct or class declaration, or a variable whose type is a candidate struct
      const isStructOrClassDecl =
        /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union)\b/m.test(cleanCode);
      const isCandidateType =
        candidate !== '' &&
        !['int', 'float', 'double', 'bool', 'char', 'void', 'long', 'short', 'auto', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'size_t'].includes(candidate);

      if (isStructOrClassDecl || isCandidateType) {
        const layout = await this.resolveStructLayout(codeBlock, hoveredWord, candidate, document, position);
        if (layout || isStructOrClassDecl) {
          return this.transform(hover, undefined, hoveredWord, layout, document?.uri, position);
        }
      }

      return this.transform(hover, undefined, hoveredWord, undefined, document?.uri, position);
    }

    const doc = await findStlDocumentationAsync(sig.name, sig.scope);
    return this.transform(hover, doc ?? undefined, hoveredWord, undefined, document?.uri, position);
  }

  private static async resolveStructLayout(
    codeBlock: string,
    hoveredWord?: string,
    candidateType?: string,
    document?: vscode.TextDocument,
    position?: vscode.Position
  ): Promise<StructLayout | null> {
    const rawName = candidateType || hoveredWord || '';
    const cleanName = rawName.split('::').pop() || rawName;

    // 1. Try comprehensive cross-file, include, and definition resolution
    if (document) {
      try {
        const resolved = await resolveStructDefinition(document, position, cleanName);
        if (resolved) {
          return resolved.layout;
        }
      } catch {
        // Fall back to local parsing
      }
    }

    let parsed = null;

    // 2. Fallback: Try parsing directly from codeBlock if it contains a struct body with fields { ... }
    if (!parsed && codeBlock.includes('{') && codeBlock.includes('}')) {
      const openIdx = codeBlock.indexOf('{');
      const closeIdx = codeBlock.lastIndexOf('}');
      if (closeIdx > openIdx) {
        const fromCode = extractStructAtPosition(codeBlock, openIdx);
        if (fromCode && (!cleanName || fromCode.name === cleanName)) {
          parsed = fromCode;
        } else if (cleanName) {
          parsed = findStructByName(codeBlock, cleanName);
        }
      }
    }

    if (!parsed || parsed.fields.length === 0) {
      return null;
    }

    if (cleanName && parsed.name !== cleanName) {
      return null;
    }

    const dataModel: DataModel = process.platform === 'win32' ? 'LLP64' : 'LP64';
    try {
      return NativeBridge.calculateStructLayout(parsed.name, parsed.fields, {
        isPacked: parsed.isPacked,
        maxPackAlignment: parsed.maxPackAlignment,
        structAlignment: parsed.structAlignment,
        dataModel
      });
    } catch {
      return null;
    }
  }
}
