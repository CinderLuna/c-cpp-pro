import * as vscode from 'vscode';
import { Middleware } from 'vscode-languageclient';
import { HoverTransformer } from '../intelligence/hover-transformer';
import {
  HeaderHoverProvider,
  parseIncludeLine,
  resolveLocalHeaderPath,
  extractPathFromClangdHover
} from '../intelligence/header-hover-provider';
import { prioritizeDefinitionLocations } from '../intelligence/smart-definition';
import { DotToArrowController } from '../intelligence/dot-to-arrow';
import { StlRankingTable } from '../telemetry/ranking-table';
import { extractStlSymbolKey } from '../telemetry/allowlist';
import { findStlDocumentation, StlDocEntry } from '../intelligence/stl-knowledge-base';

/**
 * Creates a debounced function that delays invoking func until after wait milliseconds
 * have elapsed since the last time the debounced function was invoked.
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  let timeout: NodeJS.Timeout | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timeout = null;
      func(...args);
    }, wait);
  };

  debounced.cancel = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return debounced;
}

/**
 * Enriches a completion item with Rust-like STL documentation card if matching standard library symbol.
 */
export function enrichCompletionItemWithStl(item: vscode.CompletionItem): void {
  try {
    const symbolKey = extractStlSymbolKey(item);
    let docEntry: StlDocEntry | null = null;
    if (symbolKey) {
      docEntry = findStlDocumentation(symbolKey);
    }
    const labelStr = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
    if (!docEntry && labelStr) {
      const detailStr = typeof item.detail === 'string' ? item.detail : undefined;
      docEntry = findStlDocumentation(labelStr, detailStr);
    }
    if (!docEntry && labelStr) {
      const cleanLabel = labelStr.trim().replace(/\(.*\)$/, '');
      for (const prefix of [
        'std::vector::',
        'std::string::',
        'std::map::',
        'std::unordered_map::',
        'std::span::'
      ]) {
        const candidate = `${prefix}${cleanLabel}`;
        const found = findStlDocumentation(candidate);
        if (found) {
          docEntry = found;
          break;
        }
      }
    }

    if (!docEntry) {
      return;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`### \`${docEntry.symbol}\` *(Standard Library)*\n\n`);
    md.appendMarkdown(
      `**Standard**: \`[Standard Library]\` \`[${docEntry.header}]\` \`[${docEntry.standard}]\`\n\n`
    );
    md.appendCodeblock(docEntry.canonicalSignature, 'cpp');
    md.appendMarkdown(`${docEntry.summary}\n\n`);

    if (docEntry.complexity) {
      const timeBadge = `**Time**: \`${docEntry.complexity.time}\``;
      const spaceBadge = docEntry.complexity.space
        ? ` | **Space**: \`${docEntry.complexity.space}\``
        : '';
      md.appendMarkdown(`**Complexity**: ${timeBadge}${spaceBadge}\n\n`);
    }

    if (docEntry.exceptionSafety) {
      md.appendMarkdown(`**Exception Safety**: ${docEntry.exceptionSafety}\n\n`);
    }

    if (docEntry.invalidation) {
      md.appendMarkdown(`> **Iterator Invalidation**: ${docEntry.invalidation}\n\n`);
    }

    if (docEntry.example) {
      md.appendMarkdown('#### Example\n\n');
      md.appendCodeblock(docEntry.example, 'cpp');
      md.appendMarkdown('\n');
    }

    md.appendMarkdown('---\n');
    md.appendMarkdown(`[cppreference: ${docEntry.symbol}](${docEntry.docUrl})`);

    item.documentation = md;
    const headerTag = `[${docEntry.header}]`;
    if (!item.detail || item.detail.startsWith('(')) {
      const firstLine = docEntry.canonicalSignature.split('\n')[0];
      item.detail = `${headerTag} ${firstLine}`;
    } else if (!item.detail.includes(headerTag)) {
      item.detail = `${headerTag} ${item.detail}`;
    }
  } catch {
    // Fail silently to prevent interrupting autocomplete
  }
}

/**
 * Detects whether an error is caused by a destroyed or closing stdio stream or closed LSP connection.
 */
export function isConnectionOrStreamError(error: unknown): boolean {
  if (!error) return false;
  const msg = String((error as any).message ?? error);
  const code = (error as any).code;
  return (
    code === -32099 || // LSPErrorCodes.ServerCancelled / Stream destroyed
    code === -32097 || // ServerNotInitialized
    code === 'ERR_STREAM_DESTROYED' ||
    msg.includes('stream was destroyed') ||
    msg.includes('Cannot call write after a stream was destroyed') ||
    msg.includes('Connection got disposed') ||
    msg.includes('connection is closed') ||
    msg.includes('Language client is not running') ||
    msg.includes('Connection to server is erroring')
  );
}

/**
 * Applies protocol filters and LSP client middleware to preserve Clangd's
 * semantic precision, trigger parameter hints, format qualified symbols,
 * debounce rapid editor UI events, and gracefully isolate stream lifecycle errors.
 */
export function createClangdMiddleware(
  rankingTable: StlRankingTable = new StlRankingTable(),
  isServerReady?: () => boolean
): Middleware {
  return {
    provideCompletionItem: async (
      document: vscode.TextDocument,
      position: vscode.Position,
      context: vscode.CompletionContext,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.CompletionContext,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList>
    ): Promise<vscode.CompletionList | vscode.CompletionItem[]> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return [];
      }

      let list: vscode.CompletionList | vscode.CompletionItem[] | null | undefined;
      try {
        list = await next(document, position, context, token);
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return [];
        }
        throw err;
      }

      if (token.isCancellationRequested || !list) {
        return list ?? [];
      }

      const rawItems = Array.isArray(list) ? list : list.items;
      const isIncomplete = Array.isArray(list) ? false : list.isIncomplete;

      let items = rawItems;
      try {
        items = await DotToArrowController.processCompletionItems(
          document,
          position,
          rawItems
        );
      } catch {
        items = rawItems;
      }

      const MAX_DIRECT_ENRICH = 25;
      const itemCount = items.length;

      for (let i = 0; i < itemCount; i++) {
        if (i % 50 === 0 && token.isCancellationRequested) {
          return new vscode.CompletionList(items, isIncomplete);
        }

        const item = items[i];

        // A. Apply Adaptive Empirical STL Re-Ranking
        rankingTable.applyStlRanking(item);

        // B. Completion Re-Ranking Preservation
        const labelText = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
        if (!item.filterText && labelText) {
          item.filterText = labelText;
        }

        // Avoid accidental commits on punctuation
        item.commitCharacters = [];

        // C. Parameter Hints & Usage Telemetry Hook on Insertion
        const symbolKey = extractStlSymbolKey(item);
        let baseCommand: vscode.Command | undefined = item.command;

        if (!baseCommand && item.insertText instanceof vscode.SnippetString) {
          if (item.insertText.value.match(/[([{<,] ?\$\{?[01]\D/)) {
            baseCommand = {
              title: 'Trigger Parameter Hints',
              command: 'editor.action.triggerParameterHints'
            };
          }
        }

        if (symbolKey) {
          item.command = {
            title: 'Record STL Usage',
            command: 'c-cpp-pro.onStlItemAccepted',
            arguments: [symbolKey, baseCommand]
          };
        } else if (baseCommand) {
          item.command = baseCommand;
        }

        // D. Enrich with Rust-like STL Documentation Card
        if (itemCount <= MAX_DIRECT_ENRICH || i < MAX_DIRECT_ENRICH) {
          enrichCompletionItemWithStl(item);
        }
      }

      return new vscode.CompletionList(items, isIncomplete);
    },

    resolveCompletionItem: async (
      item: vscode.CompletionItem,
      token: vscode.CancellationToken,
      next: (
        item: vscode.CompletionItem,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.CompletionItem>
    ): Promise<vscode.CompletionItem> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return item;
      }
      try {
        const resolved = (await next(item, token)) ?? item;
        if (!resolved.documentation) {
          enrichCompletionItemWithStl(resolved);
        }
        return resolved;
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return item;
        }
        throw err;
      }
    },

    provideWorkspaceSymbols: async (
      query: string,
      token: vscode.CancellationToken,
      next: (
        query: string,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.SymbolInformation[]>
    ): Promise<vscode.SymbolInformation[] | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return [];
      }
      let symbols: vscode.SymbolInformation[] | null | undefined;
      try {
        symbols = await next(query, token);
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return [];
        }
        throw err;
      }
      if (!query.includes('::') || !symbols) {
        return symbols;
      }

      return symbols.map((symbol) => {
        if (symbol.containerName) {
          symbol.name = `${symbol.containerName}::${symbol.name}`;
          symbol.containerName = '';
        }
        return symbol;
      });
    },

    provideHover: async (
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.Hover>
    ): Promise<vscode.Hover | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return null;
      }

      const lineText = document.lineAt(position.line).text;
      const includeInfo = parseIncludeLine(lineText, position.line, position.character);

      let cachedHover: vscode.Hover | null | undefined = undefined;
      let nextCalled = false;

      const getHover = async (): Promise<vscode.Hover | null | undefined> => {
        if (!nextCalled) {
          nextCalled = true;
          try {
            cachedHover = await next(document, position, token);
          } catch {
            cachedHover = null;
          }
        }
        return cachedHover;
      };

      if (includeInfo) {
        let resolvedPath: string | undefined;
        try {
          const rawHover = await getHover();
          if (rawHover) {
            resolvedPath = extractPathFromClangdHover(rawHover);
          }
        } catch {
          // Language server offline or indexing
        }

        const headerHover = await HeaderHoverProvider.provideHeaderHover(
          document,
          position,
          includeInfo,
          resolvedPath
        );
        if (headerHover) {
          return headerHover;
        }
      }

      const hover = await getHover();
      if (!hover) {
        return hover;
      }
      const wordRange =
        typeof document.getWordRangeAtPosition === 'function'
          ? document.getWordRangeAtPosition(position)
          : undefined;
      const hoveredWord = wordRange ? document.getText(wordRange) : undefined;
      return HoverTransformer.transformAsync(hover, hoveredWord, document, position);
    },

    provideDefinition: async (
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]>
    ): Promise<vscode.Definition | vscode.LocationLink[] | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return null;
      }

      let defs: vscode.Definition | vscode.LocationLink[] | null | undefined;
      try {
        defs = await next(document, position, token);
      } catch (err: unknown) {
        if (!isConnectionOrStreamError(err)) {
          throw err;
        }
      }

      if (defs && (!Array.isArray(defs) || defs.length > 0)) {
        return prioritizeDefinitionLocations(defs as any);
      }

      if (token.isCancellationRequested) {
        return null;
      }

      // Fallback: If cursor is on an include directive, resolve the header file directly on disk
      try {
        const lineText = document.lineAt(position.line).text;
        const includeInfo = parseIncludeLine(lineText, position.line, position.character);
        if (includeInfo) {
          const resolved = resolveLocalHeaderPath(includeInfo.headerName, document.uri);
          if (resolved) {
            return new vscode.Location(
              vscode.Uri.file(resolved),
              new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0))
            );
          }
        }
      } catch {
        // Ignore fallback errors
      }

      return defs;
    },

    provideDocumentSemanticTokens: async (
      document: vscode.TextDocument,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.SemanticTokens>
    ): Promise<vscode.SemanticTokens | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return null;
      }
      try {
        return await next(document, token);
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return null;
        }
        throw err;
      }
    },

    provideDocumentSemanticTokensEdits: async (
      document: vscode.TextDocument,
      previousResultId: string,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        previousResultId: string,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.SemanticTokensEdits | vscode.SemanticTokens>
    ): Promise<vscode.SemanticTokensEdits | vscode.SemanticTokens | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return null;
      }
      try {
        return await next(document, previousResultId, token);
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return null;
        }
        throw err;
      }
    },

    provideDocumentRangeSemanticTokens: async (
      document: vscode.TextDocument,
      range: vscode.Range,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.SemanticTokens>
    ): Promise<vscode.SemanticTokens | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return null;
      }
      try {
        return await next(document, range, token);
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return null;
        }
        throw err;
      }
    },

    provideInlayHints: async (
      document: vscode.TextDocument,
      range: vscode.Range,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<vscode.InlayHint[]>
    ): Promise<vscode.InlayHint[] | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return null;
      }
      try {
        return await next(document, range, token);
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return null;
        }
        throw err;
      }
    },

    provideCodeActions: async (
      document: vscode.TextDocument,
      range: vscode.Range,
      context: vscode.CodeActionContext,
      token: vscode.CancellationToken,
      next: (
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
      ) => vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]>
    ): Promise<(vscode.Command | vscode.CodeAction)[] | null | undefined> => {
      if (token.isCancellationRequested || (isServerReady && !isServerReady())) {
        return null;
      }
      try {
        return await next(document, range, context, token);
      } catch (err: unknown) {
        if (isConnectionOrStreamError(err)) {
          return null;
        }
        throw err;
      }
    }
  };
}
