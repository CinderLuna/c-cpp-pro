import * as vscode from 'vscode';

interface CMakeDocEntry {
  name: string;
  description: string;
  syntax_examples?: string[];
}

const CMAKE_KEYWORDS: Record<string, string> = {
  PUBLIC: 'Targets linking to this library will also inherit these include directories, definitions, or flags.',
  PRIVATE: 'Include directories, definitions, or flags only apply to the current target and are not propagated.',
  INTERFACE: 'Include directories, definitions, or flags only apply to consumers linking to this target, not the target itself.',
  REQUIRED: 'Stops CMake execution with an error if the requested package, file, or component cannot be found.',
  COMPONENTS: 'Specifies optional or required sub-modules/components to locate within find_package.',
  STATIC: 'Creates a static library (.lib or .a) linked into consumers at build time.',
  SHARED: 'Creates a dynamic shared library (.dll, .so, or .dylib) loaded at runtime.',
  MODULE: 'Creates a plugin/module library not linked directly, designed to be loaded dynamically via dlopen.',
  EXCLUDE_FROM_ALL: 'Excludes this target from the default "all" build target; built only when explicitly requested.',
  WIN32: 'Builds as a Windows GUI executable with WinMain instead of a console application.',
  MACOSX_BUNDLE: 'Builds as an Apple macOS application bundle (.app).',
  CONFIG: 'Instructs find_package to look directly for PackageConfig.cmake rather than FindPackage.cmake modules.',
  PROPERTIES: 'Specifies target, directory, or source file properties to set.',
  FATAL_ERROR: 'CMake message mode that immediately terminates configuration with an error.'
};

const COMMON_SNIPPETS: Array<{
  label: string;
  detail: string;
  snippet: string;
  documentation: string;
}> = [
  {
    label: 'cmake_minimum_required',
    detail: 'cmake_minimum_required(VERSION ...)',
    snippet: 'cmake_minimum_required(VERSION ${1:3.20})\n',
    documentation: 'Specify the minimum required version of CMake for this project.'
  },
  {
    label: 'project',
    detail: 'project(Name VERSION ... LANGUAGES CXX)',
    snippet: 'project(${1:ProjectName} VERSION ${2:1.0.0} LANGUAGES ${3|CXX,C,CXX C|})\n',
    documentation: 'Declare the project name, version, and enabled programming languages.'
  },
  {
    label: 'add_executable',
    detail: 'add_executable(target sources...)',
    snippet: 'add_executable(${1:target_name} ${2:src/main.cpp})\n',
    documentation: 'Define an executable target to be built from the specified source files.'
  },
  {
    label: 'add_library',
    detail: 'add_library(target STATIC|SHARED|INTERFACE sources...)',
    snippet: 'add_library(${1:lib_name} ${2|STATIC,SHARED,INTERFACE|} ${3:src/lib.cpp})\n',
    documentation: 'Define a library target to be built from the specified source files.'
  },
  {
    label: 'target_include_directories',
    detail: 'target_include_directories(target PUBLIC|PRIVATE ...)',
    snippet: 'target_include_directories(${1:target_name} ${2|PUBLIC,PRIVATE,INTERFACE|}\n  \${CMAKE_CURRENT_SOURCE_DIR}/${3:include}\n)\n',
    documentation: 'Add include directories to a target with visibility scoping.'
  },
  {
    label: 'target_link_libraries',
    detail: 'target_link_libraries(target PUBLIC|PRIVATE libs...)',
    snippet: 'target_link_libraries(${1:target_name} ${2|PUBLIC,PRIVATE,INTERFACE|} ${3:dependency})\n',
    documentation: 'Specify libraries or targets to link against, propagating interface requirements.'
  },
  {
    label: 'target_compile_definitions',
    detail: 'target_compile_definitions(target PUBLIC|PRIVATE defs...)',
    snippet: 'target_compile_definitions(${1:target_name} ${2|PUBLIC,PRIVATE,INTERFACE|} ${3:DEFINE_NAME})\n',
    documentation: 'Add preprocessor definitions to a target with visibility scoping.'
  },
  {
    label: 'find_package',
    detail: 'find_package(Name REQUIRED)',
    snippet: 'find_package(${1:PackageName} ${2:REQUIRED})\n',
    documentation: 'Locate and load settings from an external CMake package.'
  },
  {
    label: 'option',
    detail: 'option(VAR "description" ON|OFF)',
    snippet: 'option(${1:BUILD_FEATURE} "${2:Enable feature}" ${3|ON,OFF|})\n',
    documentation: 'Provide a boolean user option that can be modified via cache.'
  },
  {
    label: 'add_subdirectory',
    detail: 'add_subdirectory(dir)',
    snippet: 'add_subdirectory(${1:subdir})\n',
    documentation: 'Add a subdirectory to the build to process its CMakeLists.txt.'
  }
];

export class CMakeLanguageService implements vscode.Disposable {
  private commandsMap: Map<string, CMakeDocEntry> = new Map();
  private variablesMap: Map<string, CMakeDocEntry> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.loadCatalogData();
  }

  private loadCatalogData(): void {
    try {
      // Dynamic require of static JSON data to avoid runtime I/O failures
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cmdsData = require('./data/cmake-commands.json') as Record<string, CMakeDocEntry>;
      for (const [k, v] of Object.entries(cmdsData)) {
        this.commandsMap.set(k.toLowerCase(), v);
      }
    } catch {
      // Fallback: minimal built-in command entries
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const varsData = require('./data/cmake-variables.json') as Record<string, CMakeDocEntry>;
      for (const [k, v] of Object.entries(varsData)) {
        this.variablesMap.set(k, v);
      }
    } catch {
      // Fallback: minimal built-in variable entries
    }
  }

  /**
   * Registers completion and hover providers for the 'cmake' language.
   */
  public registerProviders(): vscode.Disposable[] {
    const selector: vscode.DocumentSelector = [
      { language: 'cmake' },
      { pattern: '**/CMakeLists.txt' },
      { pattern: '**/*.cmake' }
    ];

    const completionProvider: vscode.CompletionItemProvider = {
      provideCompletionItems: (document, position) => {
        return this.provideCompletions(document, position);
      }
    };

    const hoverProvider: vscode.HoverProvider = {
      provideHover: (document, position) => {
        return this.provideHover(document, position);
      }
    };

    const compDisp = vscode.languages.registerCompletionItemProvider(
      selector,
      completionProvider,
      '(', '{', '$', '_', '"'
    );

    const hoverDisp = vscode.languages.registerHoverProvider(selector, hoverProvider);

    this.disposables.push(compDisp, hoverDisp);
    return [compDisp, hoverDisp];
  }

  public provideCompletions(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

    // 1. Snippet completions
    for (const s of COMMON_SNIPPETS) {
      const item = new vscode.CompletionItem(s.label, vscode.CompletionItemKind.Snippet);
      item.detail = s.detail;
      item.insertText = new vscode.SnippetString(s.snippet);
      item.documentation = new vscode.MarkdownString(s.documentation);
      item.sortText = `0_${s.label}`;
      items.push(item);
    }

    // 2. Command completions
    for (const [name, entry] of this.commandsMap.entries()) {
      const item = new vscode.CompletionItem(entry.name || name, vscode.CompletionItemKind.Function);
      item.detail = `CMake Command: ${entry.name || name}`;
      item.insertText = new vscode.SnippetString(`${entry.name || name}($1)`);
      if (entry.description) {
        const doc = new vscode.MarkdownString(entry.description);
        if (entry.syntax_examples && entry.syntax_examples.length > 0) {
          doc.appendCodeblock(entry.syntax_examples[0], 'cmake');
        }
        item.documentation = doc;
      }
      item.sortText = `1_${name}`;
      items.push(item);
    }

    // 3. Variable completions (when typing ${... or standalone variable name)
    const isVariableContext = linePrefix.includes('${') || /CMAKE_/i.test(linePrefix);
    for (const [varName, entry] of this.variablesMap.entries()) {
      const item = new vscode.CompletionItem(varName, vscode.CompletionItemKind.Variable);
      item.detail = `CMake Variable: ${varName}`;
      if (entry.description) {
        item.documentation = new vscode.MarkdownString(entry.description);
      }
      item.sortText = isVariableContext ? `0_${varName}` : `2_${varName}`;
      items.push(item);
    }

    // 4. Keyword completions (PUBLIC, PRIVATE, INTERFACE, etc.)
    for (const [kw, desc] of Object.entries(CMAKE_KEYWORDS)) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.detail = `CMake Keyword: ${kw}`;
      item.documentation = new vscode.MarkdownString(desc);
      item.sortText = `3_${kw}`;
      items.push(item);
    }

    return items;
  }

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9_+-]+/);
    if (!range) return null;

    const word = document.getText(range);
    const wordLower = word.toLowerCase();

    // 1. Check for command
    const cmd = this.commandsMap.get(wordLower);
    if (cmd) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### CMake Command: \`${cmd.name}\`\n\n`);
      if (cmd.syntax_examples && cmd.syntax_examples.length > 0) {
        md.appendCodeblock(cmd.syntax_examples[0], 'cmake');
      }
      if (cmd.description) {
        md.appendMarkdown(`\n\n${cmd.description}`);
      }
      return new vscode.Hover(md, range);
    }

    // 2. Check for variable
    const variable = this.variablesMap.get(word);
    if (variable) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### CMake Variable: \`${variable.name}\`\n\n`);
      if (variable.description) {
        md.appendMarkdown(variable.description);
      }
      return new vscode.Hover(md, range);
    }

    // 3. Check for keyword
    const keywordDoc = CMAKE_KEYWORDS[word.toUpperCase()];
    if (keywordDoc) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### CMake Scope/Keyword: \`${word.toUpperCase()}\`\n\n${keywordDoc}`);
      return new vscode.Hover(md, range);
    }

    return null;
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
