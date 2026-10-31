import './vscode-mock';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import {
  HeaderHoverProvider,
  parseIncludeLine,
  extractPathFromClangdHover,
  parseLocalHeaderFile,
  resolveLocalHeaderPath,
  formatStandardHeaderHover,
  formatLocalHeaderHover,
  formatExternalHeaderHover,
  detectExternalSdk,
  isStandardHeader
} from '../src/intelligence/header-hover-provider';
import { createClangdMiddleware } from '../src/substrate/protocol-filter';
import { CppIncludeDocumentLinkProvider } from '../src/intelligence/document-links';
import { mockVscode } from './vscode-mock';

describe('Header Include Rich Hover Provider', () => {
  describe('parseIncludeLine', () => {
    it('should parse standard header include directives', () => {
      const parsed = parseIncludeLine('#include <vector>', 0, 5);
      assert.ok(parsed);
      assert.strictEqual(parsed.isStandard, true);
      assert.strictEqual(parsed.headerName, 'vector');
      assert.strictEqual(parsed.headerText, '<vector>');
      assert.strictEqual(parsed.range.start.line, 0);
      assert.strictEqual(parsed.range.start.character, 0);
      assert.strictEqual(parsed.range.end.character, 17);
    });

    it('should parse include directives with arbitrary whitespace', () => {
      const parsed = parseIncludeLine('   #   include   <cmath>   ', 2);
      assert.ok(parsed);
      assert.strictEqual(parsed.isStandard, true);
      assert.strictEqual(parsed.headerName, 'cmath');
      assert.strictEqual(parsed.headerText, '<cmath>');
      assert.strictEqual(parsed.range.start.line, 2);
    });

    it('should parse local project header include directives with quotes', () => {
      const parsed = parseIncludeLine('#include "engine/mesh.h"', 1, 10);
      assert.ok(parsed);
      assert.strictEqual(parsed.isStandard, false);
      assert.strictEqual(parsed.headerName, 'engine/mesh.h');
      assert.strictEqual(parsed.headerText, '"engine/mesh.h"');
    });

    it('should return null for non-include lines', () => {
      assert.strictEqual(parseIncludeLine('int x = 42;'), null);
      assert.strictEqual(parseIncludeLine('// #include <vector>'), null);
      assert.strictEqual(parseIncludeLine('/* #include <string> */'), null);
      assert.strictEqual(parseIncludeLine('#define FOO 1'), null);
    });

    it('should return null if hover cursor position is outside the include directive', () => {
      const line = '#include <vector>';
      const parsed = parseIncludeLine(line, 0, 50);
      assert.strictEqual(parsed, null);
    });
  });

  describe('extractPathFromClangdHover', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-header-hover-'));
    const dummyHeader = path.join(tempDir, 'dummy.h');

    before(() => {
      fs.writeFileSync(dummyHeader, 'int foo();\n');
    });

    after(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Cleanup
      }
    });

    it('should extract resolved file path from Clangd hover content', () => {
      const hover: any = {
        contents: [
          new mockVscode.MarkdownString(`dummy.h\n\n${dummyHeader}`)
        ]
      };
      const extracted = extractPathFromClangdHover(hover);
      assert.ok(extracted);
      assert.strictEqual(path.normalize(extracted), path.normalize(dummyHeader));
    });

    it('should return undefined if hover contents contain no valid file path', () => {
      const hover: any = {
        contents: [
          new mockVscode.MarkdownString('dummy.h\n\nNo such file exists anywhere')
        ]
      };
      assert.strictEqual(extractPathFromClangdHover(hover), undefined);
    });

    it('should handle empty or null hovers safely', () => {
      assert.strictEqual(extractPathFromClangdHover(null as any), undefined);
      assert.strictEqual(extractPathFromClangdHover({ contents: [] } as any), undefined);
    });
  });

  describe('parseLocalHeaderFile & resolveLocalHeaderPath', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-local-header-'));
    const headerPath = path.join(tempDir, 'geometry.h');

    before(() => {
      const headerCode = `
#pragma once

// Forward declarations and classes
class Shape3D {
public:
    virtual double volume() const = 0;
};

struct Point3D {
    double x;
    double y;
    double z;
};

concept Transformable = requires(T a) {
    a.transform();
};

enum class ColorMode {
    RGB,
    RGBA
};

// Functions
double calculateBoundingBox(const Point3D& min, const Point3D& max);
void renderMesh(const Shape3D& shape, ColorMode mode);
`;
      fs.writeFileSync(headerPath, headerCode);
    });

    after(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Cleanup
      }
    });

    it('should statically parse classes, structs, concepts, enums, and functions from local header', () => {
      const symbols = parseLocalHeaderFile(headerPath);
      assert.ok(symbols.length >= 5);

      const names = symbols.map((s) => s.name);
      assert.ok(names.includes('Shape3D'), 'Missing Shape3D class');
      assert.ok(names.includes('Point3D'), 'Missing Point3D struct');
      assert.ok(names.includes('Transformable'), 'Missing Transformable concept');
      assert.ok(names.includes('ColorMode'), 'Missing ColorMode enum');
      assert.ok(names.includes('calculateBoundingBox'), 'Missing calculateBoundingBox function');
      assert.ok(names.includes('renderMesh'), 'Missing renderMesh function');
    });

    it('should resolve local header relative to document directory', () => {
      const docUri = vscode.Uri.file(path.join(tempDir, 'main.cpp'));
      const resolved = resolveLocalHeaderPath('geometry.h', docUri);
      assert.ok(resolved);
      assert.strictEqual(path.normalize(resolved), path.normalize(headerPath));
    });

    it('should return undefined when local header cannot be located', () => {
      const docUri = vscode.Uri.file(path.join(tempDir, 'main.cpp'));
      const resolved = resolveLocalHeaderPath('non_existent_file_xyz.h', docUri);
      assert.strictEqual(resolved, undefined);
    });

    it('should resolve application/file.h when document is inside application directory', () => {
      const appDir = path.join(tempDir, 'src', 'application');
      fs.mkdirSync(appDir, { recursive: true });
      const targetHeader = path.join(appDir, 'Editing.h');
      fs.writeFileSync(targetHeader, '// Header content', 'utf8');

      const docUri = vscode.Uri.file(path.join(appDir, 'Editing.cpp'));
      const resolved = resolveLocalHeaderPath('application/Editing.h', docUri);
      assert.ok(resolved);
      assert.strictEqual(path.normalize(resolved), path.normalize(targetHeader));
    });
  });

  describe('formatStandardHeaderHover', () => {
    it('should generate hover card for <vector> listing functions and primary types', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'vector',
          headerText: '<vector>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 17)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<vector>` *(C++ Standard Library)*'));
        assert.ok(md.includes('Sequence container that encapsulates dynamic size contiguous arrays'));
        assert.ok(md.includes('#### Primary Types'));
        assert.ok(md.includes('`std::vector`'));
        assert.ok(md.includes('#### Available Functions'));
        assert.ok(md.includes('`push_back`'));
        assert.ok(md.includes('`emplace_back`'));
        assert.ok(md.includes('https://en.cppreference.com/w/cpp/container/vector'));
      });
    });

    it('should generate hover card for <cmath> listing math functions', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'cmath',
          headerText: '<cmath>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 16)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<cmath>` *(C++ Standard Library)*'));
        assert.ok(md.includes('Common mathematical operations'));
        assert.ok(md.includes('#### Available Functions'));
        assert.ok(md.includes('`sqrt`'));
        assert.ok(md.includes('`pow`'));
        assert.ok(md.includes('`abs`'));
      });
    });

    it('should generate hover card for <algorithm> listing algorithms', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'algorithm',
          headerText: '<algorithm>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 20)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<algorithm>` *(C++ Standard Library)*'));
        assert.ok(md.includes('#### Available Functions'));
        assert.ok(md.includes('`sort`'));
        assert.ok(md.includes('`find`'));
        assert.ok(md.includes('`transform`'));
      });
    });

    it('should generate hover card for <iostream> listing I/O objects and functions', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'iostream',
          headerText: '<iostream>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 19)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<iostream>` *(C++ Standard Library)*'));
        assert.ok(md.includes('`cout`'));
        assert.ok(md.includes('`cin`'));
      });
    });

    it('should generate hover card for C standard header <stdio.h> listing functions and C standard classification', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.c') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'stdio.h',
          headerText: '<stdio.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 18)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<stdio.h>` *(C Standard Library)*'));
        assert.ok(md.includes('**Standard**: `[C Standard Library]` `[<stdio.h>]`'));
        assert.ok(md.includes('Standard C input and output operations'));
        assert.ok(md.includes('#### Available Functions'));
        assert.ok(md.includes('`printf`'));
        assert.ok(md.includes('`snprintf`'));
        assert.ok(md.includes('`fopen`'));
        assert.ok(md.includes('https://en.cppreference.com/w/c/io'));
      });
    });

    it('should generate hover card for C standard header <math.h> listing math functions', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.c') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'math.h',
          headerText: '<math.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 17)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<math.h>` *(C Standard Library)*'));
        assert.ok(md.includes('#### Available Functions'));
        assert.ok(md.includes('`sqrt`'));
        assert.ok(md.includes('`pow`'));
        assert.ok(md.includes('`abs`'));
      });
    });

    it('should generate hover card for C standard header <stdlib.h> listing memory and utility functions', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.c') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'stdlib.h',
          headerText: '<stdlib.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 19)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<stdlib.h>` *(C Standard Library)*'));
        assert.ok(md.includes('#### Available Functions'));
        assert.ok(md.includes('`malloc`'));
        assert.ok(md.includes('`free`'));
        assert.ok(md.includes('`exit`'));
      });
    });

    it('should generate hover card for C standard header <string.h> listing string and memory functions', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.c') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'string.h',
          headerText: '<string.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 19)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<string.h>` *(C Standard Library)*'));
        assert.ok(md.includes('#### Available Functions'));
        assert.ok(md.includes('`memcpy`'));
        assert.ok(md.includes('`strlen`'));
        assert.ok(md.includes('`strcpy`'));
      });
    });

    it('should generate hover card for Windows header <windows.h> with Win32 classification and symbols', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'windows.h',
          headerText: '<windows.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 20)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<windows.h>` *(Windows SDK / Win32 API)*'));
        assert.ok(md.includes('**Standard**: `[Windows SDK]` `[<windows.h>]`'));
        assert.ok(md.includes('Master C/C++ include header for the Microsoft Windows API'));
        assert.ok(md.includes('`CreateWindowEx`') || md.includes('`CreateFileW`'));
      });
    });

    it('should generate hover card for POSIX header <unistd.h> with POSIX classification and symbols', () => {
      const hover = HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/src/main.c') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'unistd.h',
          headerText: '<unistd.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 19)
        }
      );

      return hover.then((result) => {
        assert.ok(result);
        const md = (result.contents as any).value || (result.contents[0] as any).value;
        assert.ok(md.includes('### Header `<unistd.h>` *(POSIX System Library)*'));
        assert.ok(md.includes('**Standard**: `[POSIX Library]` `[<unistd.h>]`'));
        assert.ok(md.includes('`fork`'));
        assert.ok(md.includes('`read`'));
        assert.ok(md.includes('`write`'));
      });
    });

    it('should display resolved file path when provided', () => {
      const hover = formatStandardHeaderHover(
        'vector',
        [],
        'C:/MSVC/include/vector'
      );
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('**Resolved Path**: `C:/MSVC/include/vector`'));
    });
  });

  describe('formatLocalHeaderHover', () => {
    it('should format project header hover card with declared symbols', () => {
      const symbols = [
        { name: 'Matrix4', kind: 'class' as const },
        { name: 'Vector3', kind: 'struct' as const },
        { name: 'multiply', kind: 'function' as const, signature: 'Matrix4 multiply(const Matrix4& a, const Matrix4& b);' }
      ];
      const hover = formatLocalHeaderHover('math/matrix.h', symbols, '/workspace/math/matrix.h');
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;

      assert.ok(md.includes('### Header `"math/matrix.h"` *(Project Header)*'));
      assert.ok(md.includes('**Path**: `/workspace/math/matrix.h`'));
      assert.ok(md.includes('`Matrix4`'));
      assert.ok(md.includes('`Vector3`'));
      assert.ok(md.includes('`multiply`'));
      assert.ok(md.includes('[Switch Header/Source]'));
    });

    it('should format external header hover card with sdk details and documentation links', () => {
      const symbols = [
        { name: 'VkInstance', kind: 'struct' as const }
      ];
      const hover = formatExternalHeaderHover(
        'vulkan/vulkan.h',
        {
          sdkName: 'Vulkan SDK',
          categoryTag: 'Vulkan SDK',
          summary: 'Vulkan graphics API',
          docUrl: 'https://registry.khronos.org/vulkan/specs/latest/man/html/'
        },
        symbols,
        '/opt/vulkan/include/vulkan/vulkan.h'
      );
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;

      assert.ok(md.includes('### Header `<vulkan/vulkan.h>` *(Vulkan SDK)*'));
      assert.ok(md.includes('**Category**: `[Vulkan SDK]` `[<vulkan/vulkan.h>]`'));
      assert.ok(md.includes('**Resolved Path**: `/opt/vulkan/include/vulkan/vulkan.h`'));
      assert.ok(md.includes('`VkInstance`'));
      assert.ok(md.includes('https://registry.khronos.org/vulkan/specs/latest/man/html/'));
    });
  });

  describe('Language Server Protocol Filter Integration', () => {
    it('should intercept hover on #include <vector> line and return rich functions list', async () => {
      const middleware = createClangdMiddleware();
      assert.ok(middleware.provideHover);

      const mockDoc: any = {
        lineAt: (_line: number) => ({ text: '#include <vector>' }),
        uri: vscode.Uri.file('/workspace/src/app.cpp')
      };
      const mockPos = new mockVscode.Position(0, 10);
      const mockToken = {} as any;

      // Mock Clangd language server returning default bare hover
      const mockNext = async () => {
        return new mockVscode.Hover([
          new mockVscode.MarkdownString('vector\n\nC:/MSVC/include/vector')
        ]);
      };

      const result = await middleware.provideHover!(mockDoc, mockPos, mockToken, mockNext);
      assert.ok(result);
      const md = (result.contents as any).value || (result.contents[0] as any).value;

      assert.ok(md.includes('### Header `<vector>` *(C++ Standard Library)*'));
      assert.ok(md.includes('Available Functions'));
      assert.ok(md.includes('`push_back`'));
      assert.ok(md.includes('`emplace_back`'));
    });

    it('should intercept hover on #include <stdio.h> line and return rich C Standard Library functions list', async () => {
      const middleware = createClangdMiddleware();
      assert.ok(middleware.provideHover);

      const mockDoc: any = {
        lineAt: (_line: number) => ({ text: '#include <stdio.h>' }),
        uri: vscode.Uri.file('/workspace/src/app.c')
      };
      const mockPos = new mockVscode.Position(0, 10);
      const mockToken = {} as any;

      const mockNext = async () => {
        return new mockVscode.Hover([
          new mockVscode.MarkdownString('stdio.h\n\nC:/MSVC/include/stdio.h')
        ]);
      };

      const result = await middleware.provideHover!(mockDoc, mockPos, mockToken, mockNext);
      assert.ok(result);
      const md = (result.contents as any).value || (result.contents[0] as any).value;

      assert.ok(md.includes('### Header `<stdio.h>` *(C Standard Library)*'));
      assert.ok(md.includes('Available Functions'));
      assert.ok(md.includes('`printf`'));
      assert.ok(md.includes('`fopen`'));
    });

    it('should bypass include hover on non-include lines and fall through to standard hover transformer', async () => {
      const middleware = createClangdMiddleware();
      const mockDoc: any = {
        lineAt: (_line: number) => ({ text: 'int computeAnswer() {' }),
        uri: vscode.Uri.file('/workspace/src/app.cpp')
      };
      const mockPos = new mockVscode.Position(0, 4);
      const mockToken = {} as any;

      const mockNext = async () => {
        return new mockVscode.Hover([
          new mockVscode.MarkdownString('```cpp\nint computeAnswer();\n```')
        ]);
      };

      const result = await middleware.provideHover!(mockDoc, mockPos, mockToken, mockNext);
      assert.ok(result);
      const md = (result.contents as any).value || (result.contents[0] as any).value;
      assert.ok(md.includes('computeAnswer'));
      assert.ok(!md.includes('C++ Standard Library'));
    });

    it('should fallback to local header file location when language server definition returns empty', async () => {
      const middleware = createClangdMiddleware();
      assert.ok(middleware.provideDefinition);

      const tempAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-def-test-'));
      try {
        const appDir = path.join(tempAppDir, 'src', 'application');
        fs.mkdirSync(appDir, { recursive: true });
        const targetHeader = path.join(appDir, 'Editing.h');
        fs.writeFileSync(targetHeader, '#pragma once\n', 'utf8');

        const mockDoc: any = {
          lineAt: (_line: number) => ({ text: '#include "application/Editing.h"' }),
          uri: vscode.Uri.file(path.join(appDir, 'Editing.cpp'))
        };
        const mockPos = new mockVscode.Position(0, 15);
        const mockToken = {} as any;

        // Mock next returning null/empty
        const mockNext = async () => null;

        const result = (await middleware.provideDefinition!(
          mockDoc,
          mockPos,
          mockToken,
          mockNext
        )) as vscode.Location;

        assert.ok(result);
        assert.strictEqual(path.normalize(result.uri.fsPath), path.normalize(targetHeader));
        assert.strictEqual(result.range.start.line, 0);
      } finally {
        try {
          fs.rmSync(tempAppDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });

    it('should extract document links for resolved local header includes', () => {
      const tempAppDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-doclink-test-'));
      try {
        const appDir = path.join(tempAppDir, 'src', 'application');
        fs.mkdirSync(appDir, { recursive: true });
        const targetHeader = path.join(appDir, 'Editing.h');
        fs.writeFileSync(targetHeader, '#pragma once\n', 'utf8');

        const docUri = vscode.Uri.file(path.join(appDir, 'Editing.cpp'));
        const mockDoc: any = {
          lineCount: 2,
          lineAt: (i: number) => ({
            text: i === 0 ? '#include "application/Editing.h"' : 'int x = 0;'
          }),
          uri: docUri
        };

        const provider = new CppIncludeDocumentLinkProvider();
        const links = provider.provideDocumentLinks(mockDoc, {} as any);

        assert.strictEqual(links.length, 1);
        assert.ok(links[0].target);
        assert.strictEqual(path.normalize(links[0].target.fsPath), path.normalize(targetHeader));
      } finally {
        try {
          fs.rmSync(tempAppDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });
  });

  describe('isStandardHeader & External SDK Classification', () => {
    it('should correctly classify ISO C++, C, Windows SDK, and POSIX headers as standard', () => {
      assert.strictEqual(isStandardHeader('vector'), true);
      assert.strictEqual(isStandardHeader('string'), true);
      assert.strictEqual(isStandardHeader('cmath'), true);
      assert.strictEqual(isStandardHeader('iostream'), true);
      assert.strictEqual(isStandardHeader('algorithm'), true);
      assert.strictEqual(isStandardHeader('stdio.h'), true);
      assert.strictEqual(isStandardHeader('cstdio'), true);
      assert.strictEqual(isStandardHeader('math.h'), true);
      assert.strictEqual(isStandardHeader('windows.h'), true);
      assert.strictEqual(isStandardHeader('winsock2.h'), true);
      assert.strictEqual(isStandardHeader('unistd.h'), true);
      assert.strictEqual(isStandardHeader('sys/stat.h'), true);
    });

    it('should not classify external SDK and third-party library headers as standard', () => {
      assert.strictEqual(isStandardHeader('qstackedwidget'), false);
      assert.strictEqual(isStandardHeader('QStackedWidget'), false);
      assert.strictEqual(isStandardHeader('QtWidgets/QStackedWidget'), false);
      assert.strictEqual(isStandardHeader('vulkan/vulkan.h'), false);
      assert.strictEqual(isStandardHeader('raylib.h'), false);
      assert.strictEqual(isStandardHeader('boost/asio.hpp'), false);
      assert.strictEqual(isStandardHeader('SDL2/SDL.h'), false);
      assert.strictEqual(isStandardHeader('SDL.h'), false);
      assert.strictEqual(isStandardHeader('cuda_runtime.h'), false);
      assert.strictEqual(isStandardHeader('opencv2/opencv.hpp'), false);
      assert.strictEqual(isStandardHeader('engine/mesh.h'), false);
    });

    it('should detect Qt SDK headers and provide Qt documentation URL', () => {
      const qsw = detectExternalSdk('qstackedwidget', 'F:\\Apps\\Qt\\6.9.3\\mingw_64\\include\\QtWidgets\\QStackedWidget');
      assert.ok(qsw);
      assert.strictEqual(qsw.sdkName, 'Qt Framework');
      assert.ok(qsw.summary.includes('Qt Widgets'));
      assert.strictEqual(qsw.docUrl, 'https://doc.qt.io/qt-6/qstackedwidget.html');

      const qObj = detectExternalSdk('QObject');
      assert.ok(qObj);
      assert.strictEqual(qObj.sdkName, 'Qt Framework');
      assert.ok(qObj.summary.includes('Qt Core'));
      assert.strictEqual(qObj.docUrl, 'https://doc.qt.io/qt-6/qobject.html');

      const qtMod = detectExternalSdk('QtWidgets/QStackedWidget');
      assert.ok(qtMod);
      assert.strictEqual(qtMod.sdkName, 'Qt Framework');
      assert.strictEqual(qtMod.docUrl, 'https://doc.qt.io/qt-6/qstackedwidget.html');
    });

    it('should detect Vulkan, raylib, Boost, SDL, and CUDA headers', () => {
      const vulkan = detectExternalSdk('vulkan/vulkan.h');
      assert.ok(vulkan);
      assert.strictEqual(vulkan.sdkName, 'Vulkan SDK');
      assert.ok(vulkan.docUrl?.includes('khronos.org'));

      const raylib = detectExternalSdk('raylib.h');
      assert.ok(raylib);
      assert.strictEqual(raylib.sdkName, 'raylib');
      assert.ok(raylib.docUrl?.includes('raylib.com'));

      const boost = detectExternalSdk('boost/asio.hpp');
      assert.ok(boost);
      assert.strictEqual(boost.sdkName, 'Boost C++ Libraries');

      const sdl = detectExternalSdk('SDL2/SDL.h');
      assert.ok(sdl);
      assert.strictEqual(sdl.sdkName, 'Simple DirectMedia Layer (SDL)');

      const cuda = detectExternalSdk('cuda_runtime.h');
      assert.ok(cuda);
      assert.strictEqual(cuda.sdkName, 'NVIDIA CUDA Toolkit');
    });
  });

  describe('External SDK & Library Hover Rendering', () => {
    it('should format Qt header hover card without C++ Standard Library or cppreference badges', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'qstackedwidget',
          headerText: '<qstackedwidget>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 26)
        },
        'F:\\Apps\\Qt\\6.9.3\\mingw_64\\include\\QtWidgets\\QStackedWidget'
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<qstackedwidget>` *(Qt Framework)*'));
      assert.ok(md.includes('**Category**: `[Qt Framework]` `[<qstackedwidget>]`'));
      assert.ok(md.includes('Part of the Qt Widgets module'));
      assert.ok(md.includes('**Resolved Path**: `F:\\Apps\\Qt\\6.9.3\\mingw_64\\include\\QtWidgets\\QStackedWidget`'));
      assert.ok(md.includes('https://doc.qt.io/qt-6/qstackedwidget.html'));
      assert.ok(!md.includes('C++ Standard Library'));
      assert.ok(!md.includes('cppreference'));
    });

    it('should format Vulkan header hover without Standard Library badges', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'vulkan/vulkan.h',
          headerText: '<vulkan/vulkan.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 27)
        }
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<vulkan/vulkan.h>` *(Vulkan SDK)*'));
      assert.ok(md.includes('**Category**: `[Vulkan SDK]` `[<vulkan/vulkan.h>]`'));
      assert.ok(!md.includes('C++ Standard Library'));
      assert.ok(!md.includes('cppreference'));
    });

    it('should format raylib header hover without C Standard Library badges', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'raylib.h',
          headerText: '<raylib.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 20)
        }
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<raylib.h>` *(raylib)*'));
      assert.ok(md.includes('**Category**: `[raylib]` `[<raylib.h>]`'));
      assert.ok(md.includes('https://www.raylib.com/cheatsheet/cheatsheet.html'));
      assert.ok(!md.includes('C Standard Library'));
      assert.ok(!md.includes('C++ Standard Library'));
      assert.ok(!md.includes('cppreference'));
    });

    it('should follow forwarding headers like Qt QStackedWidget to extract declared classes', async () => {
      const tempQtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-qt-test-'));
      try {
        const widgetsDir = path.join(tempQtDir, 'QtWidgets');
        fs.mkdirSync(widgetsDir, { recursive: true });

        // Target header containing the actual class
        const targetHeader = path.join(widgetsDir, 'qstackedwidget.h');
        fs.writeFileSync(
          targetHeader,
          'class QStackedWidget : public QFrame {\npublic:\n  int count() const;\n};\n',
          'utf8'
        );

        // Forwarding header
        const forwardHeader = path.join(widgetsDir, 'QStackedWidget');
        fs.writeFileSync(forwardHeader, '#include "qstackedwidget.h"\n', 'utf8');

        const symbols = parseLocalHeaderFile(forwardHeader);
        assert.ok(symbols.length > 0);
        assert.strictEqual(symbols[0].name, 'QStackedWidget');
        assert.strictEqual(symbols[0].kind, 'class');
      } finally {
        try {
          fs.rmSync(tempQtDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });

    it('should not treat small headers defining their own classes as forwarding headers', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-nofwd-test-'));
      try {
        const headerFile = path.join(tempDir, 'ilogger.h');
        fs.writeFileSync(
          headerFile,
          '#pragma once\n#include <string>\n\nclass ILogger {\npublic:\n    virtual ~ILogger() = default;\n    virtual void log(const std::string& msg) = 0;\n};\n',
          'utf8'
        );
        const symbols = parseLocalHeaderFile(headerFile);
        assert.strictEqual(symbols.length, 1);
        assert.strictEqual(symbols[0].name, 'ILogger');
        assert.strictEqual(symbols[0].kind, 'class');
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });

    it('should classify Windows SDK header <fileapi.h> with Microsoft Learn link and no cppreference', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'fileapi.h',
          headerText: '<fileapi.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 19)
        }
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<fileapi.h>` *(Windows SDK / Win32 API)*'));
      assert.ok(md.includes('**Standard**: `[Windows SDK]` `[<fileapi.h>]` `[Windows SDK / Win32 API]`'));
      assert.ok(md.includes('https://learn.microsoft.com/en-us/windows/win32/api/fileapi/'));
      assert.ok(!md.includes('cppreference'));
      assert.ok(!md.includes('C Standard Library'));
    });

    it('should classify POSIX header <termios.h> with OpenGroup doc link and no cppreference', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.c') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'termios.h',
          headerText: '<termios.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 19)
        }
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<termios.h>` *(POSIX System Library)*'));
      assert.ok(md.includes('**Standard**: `[POSIX Library]` `[<termios.h>]` `[POSIX System Library]`'));
      assert.ok(md.includes('https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/termios.h.html'));
      assert.ok(!md.includes('cppreference'));
    });

    it('should format Boost header hover with Boost documentation link', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'boost/asio.hpp',
          headerText: '<boost/asio.hpp>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 24)
        }
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<boost/asio.hpp>` *(Boost C++ Libraries)*'));
      assert.ok(md.includes('https://www.boost.org/doc/libs/'));
      assert.ok(!md.includes('C++ Standard Library'));
      assert.ok(!md.includes('cppreference'));
    });

    it('should format SDL header hover with SDL documentation link', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'SDL2/SDL.h',
          headerText: '<SDL2/SDL.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 20)
        }
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<SDL2/SDL.h>` *(Simple DirectMedia Layer (SDL))*'));
      assert.ok(md.includes('https://wiki.libsdl.org/'));
      assert.ok(!md.includes('C++ Standard Library'));
      assert.ok(!md.includes('cppreference'));
    });

    it('should format CUDA header hover with CUDA documentation link', async () => {
      const hover = await HeaderHoverProvider.provideHeaderHover(
        { uri: vscode.Uri.file('/workspace/src/main.cpp') } as any,
        new mockVscode.Position(0, 0),
        {
          headerName: 'cuda_runtime.h',
          headerText: '<cuda_runtime.h>',
          isStandard: true,
          range: new mockVscode.Range(0, 0, 0, 24)
        }
      );

      assert.ok(hover);
      const md = (hover.contents as any).value || (hover.contents[0] as any).value;
      assert.ok(md.includes('### Header `<cuda_runtime.h>` *(NVIDIA CUDA Toolkit)*'));
      assert.ok(md.includes('https://docs.nvidia.com/cuda/'));
      assert.ok(!md.includes('C++ Standard Library'));
      assert.ok(!md.includes('cppreference'));
    });

    it('should prioritize workspace local header over standard header for quoted includes', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-quoted-time-'));
      try {
        const localTimeHeader = path.join(tempDir, 'time.h');
        fs.writeFileSync(
          localTimeHeader,
          '#pragma once\nclass CustomTimer {\npublic:\n    void start();\n};\n',
          'utf8'
        );

        const docUri = vscode.Uri.file(path.join(tempDir, 'main.cpp'));
        const hover = await HeaderHoverProvider.provideHeaderHover(
          { uri: docUri } as any,
          new mockVscode.Position(0, 0),
          {
            headerName: 'time.h',
            headerText: '"time.h"',
            isStandard: false,
            range: new mockVscode.Range(0, 0, 0, 16)
          }
        );

        assert.ok(hover);
        const md = (hover.contents as any).value || (hover.contents[0] as any).value;
        assert.ok(md.includes('### Header `"time.h"` *(Project Header)*'));
        assert.ok(md.includes('CustomTimer'));
        assert.ok(!md.includes('C Standard Library'));
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });

    it('should exclude standard headers from document links but link local quoted headers', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-doclink-std-'));
      try {
        const localHeader = path.join(tempDir, 'local.h');
        fs.writeFileSync(localHeader, '#pragma once\n', 'utf8');

        const docUri = vscode.Uri.file(path.join(tempDir, 'main.cpp'));
        const mockDoc: any = {
          lineCount: 3,
          lineAt: (i: number) => {
            const lines = [
              '#include <vector>',
              '#include <stdio.h>',
              '#include "local.h"'
            ];
            return { text: lines[i] };
          },
          uri: docUri
        };

        const provider = new CppIncludeDocumentLinkProvider();
        const links = provider.provideDocumentLinks(mockDoc, { isCancellationRequested: false } as any);

        assert.strictEqual(links.length, 1);
        assert.ok(links[0].target);
        assert.strictEqual(path.normalize(links[0].target.fsPath), path.normalize(localHeader));

        // Test cancellation token
        const cancelledLinks = provider.provideDocumentLinks(mockDoc, { isCancellationRequested: true } as any);
        assert.strictEqual(cancelledLinks.length, 0);
      } finally {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    });

    it('should intercept hover via Clangd middleware for Qt include and format as Qt Framework', async () => {
      const middleware = createClangdMiddleware();
      assert.ok(middleware.provideHover);

      const mockDoc: any = {
        lineAt: (_line: number) => ({ text: '#include <qstackedwidget>' }),
        uri: vscode.Uri.file('/workspace/src/main.cpp')
      };
      const mockPos = new mockVscode.Position(0, 10);
      const mockToken = {} as any;

      // Mock Clangd language server returning resolved Qt header path
      const mockNext = async () => {
        return new mockVscode.Hover([
          new mockVscode.MarkdownString('qstackedwidget\n\nF:/Apps/Qt/6.9.3/mingw_64/include/QtWidgets/QStackedWidget')
        ]);
      };

      const result = await middleware.provideHover!(mockDoc, mockPos, mockToken, mockNext);
      assert.ok(result);
      const md = (result.contents as any).value || (result.contents[0] as any).value;

      assert.ok(md.includes('### Header `<qstackedwidget>` *(Qt Framework)*'));
      assert.ok(md.includes('Part of the Qt Widgets module'));
      assert.ok(!md.includes('C++ Standard Library'));
      assert.ok(!md.includes('cppreference'));
    });
  });
});
