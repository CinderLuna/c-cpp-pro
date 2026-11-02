import './vscode-mock';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  resolveTypeInfo,
  calculateStructLayout,
  generateLayoutAsciiDiagram,
  generateLayoutMarkdown,
  extractStructAtPosition,
  findMatchingBrace,
  parseFieldsFromBody,
  findStructByName,
  resolveStructDefinition,
  MemoryLayoutInspector
} from '../src/inspector/memory-layout-inspector';

describe('Type & Memory Layout Inspector', () => {
  describe('resolveTypeInfo', () => {
    it('should resolve standard primitive types', () => {
      assert.strictEqual(resolveTypeInfo('bool').size, 1);
      assert.strictEqual(resolveTypeInfo('int').size, 4);
      assert.strictEqual(resolveTypeInfo('double').size, 8);
      assert.strictEqual(resolveTypeInfo('double').alignment, 8);
      assert.strictEqual(resolveTypeInfo('uint64_t').size, 8);
    });

    it('should resolve pointer types to 8 bytes on 64-bit systems', () => {
      assert.strictEqual(resolveTypeInfo('char*').size, 8);
      assert.strictEqual(resolveTypeInfo('void*').size, 8);
      assert.strictEqual(resolveTypeInfo('MyClass*').size, 8);
      assert.strictEqual(resolveTypeInfo('const int&').size, 8);
    });

    it('should resolve fixed array types', () => {
      const arrInfo = resolveTypeInfo('int[4]');
      assert.strictEqual(arrInfo.size, 16);
      assert.strictEqual(arrInfo.alignment, 4);

      const multiInfo = resolveTypeInfo('int[10][20]');
      assert.strictEqual(multiInfo.size, 800);
      assert.strictEqual(multiInfo.alignment, 4);
    });

    it('should support LLP64 data model for Windows MSVC (long=4, long double=8)', () => {
      assert.strictEqual(resolveTypeInfo('long', 'LLP64').size, 4);
      assert.strictEqual(resolveTypeInfo('long', 'LLP64').alignment, 4);
      assert.strictEqual(resolveTypeInfo('unsigned long', 'LLP64').size, 4);
      assert.strictEqual(resolveTypeInfo('long double', 'LLP64').size, 8);
      assert.strictEqual(resolveTypeInfo('long double', 'LLP64').alignment, 8);

      // Verify LP64 defaults
      assert.strictEqual(resolveTypeInfo('long', 'LP64').size, 8);
      assert.strictEqual(resolveTypeInfo('long double', 'LP64').size, 16);
    });

    it('should resolve Win32 primitive types', () => {
      assert.strictEqual(resolveTypeInfo('DWORD').size, 4);
      assert.strictEqual(resolveTypeInfo('DWORD').alignment, 4);
      assert.strictEqual(resolveTypeInfo('WORD').size, 2);
      assert.strictEqual(resolveTypeInfo('BYTE').size, 1);
      assert.strictEqual(resolveTypeInfo('BOOL').size, 4);
      assert.strictEqual(resolveTypeInfo('HANDLE').size, 8);
      assert.strictEqual(resolveTypeInfo('HWND').size, 8);
    });

    it('should deduce enum and state types as 4-byte integers by heuristic', () => {
      assert.strictEqual(resolveTypeInfo('GridUnitType').size, 4);
      assert.strictEqual(resolveTypeInfo('GridUnitType').alignment, 4);
      assert.strictEqual(resolveTypeInfo('RenderMode').size, 4);
      assert.strictEqual(resolveTypeInfo('NodeState').size, 4);
      assert.strictEqual(resolveTypeInfo('TokenKind').size, 4);
    });
  });

  describe('calculateStructLayout', () => {
    it('should calculate struct layout using LLP64 data model for Windows MSVC', () => {
      const fields = [
        { type: 'char', name: 'a' },
        { type: 'long', name: 'b' }
      ];

      // On LP64 (POSIX): char (1) + 7 pad + long (8) = 16 bytes
      const lp64Layout = calculateStructLayout('StructWithLong', fields, { dataModel: 'LP64' });
      assert.strictEqual(lp64Layout.totalSize, 16);
      assert.strictEqual(lp64Layout.alignment, 8);
      assert.strictEqual(lp64Layout.paddingBytes, 7);

      // On LLP64 (MSVC): char (1) + 3 pad + long (4) = 8 bytes
      const llp64Layout = calculateStructLayout('StructWithLong', fields, { dataModel: 'LLP64' });
      assert.strictEqual(llp64Layout.totalSize, 8);
      assert.strictEqual(llp64Layout.alignment, 4);
      assert.strictEqual(llp64Layout.paddingBytes, 3);
    });
    it('should correctly calculate padding for unaligned fields', () => {
      // struct BadOrder { char a; double b; int c; };
      // a: 1 byte at 0
      // padding: 7 bytes at 1 -> offset 8
      // b: 8 bytes at 8 -> offset 16
      // c: 4 bytes at 16 -> offset 20
      // tail padding: 4 bytes -> offset 24
      const fields = [
        { type: 'char', name: 'a' },
        { type: 'double', name: 'b' },
        { type: 'int', name: 'c' }
      ];

      const layout = calculateStructLayout('BadOrder', fields);
      assert.strictEqual(layout.totalSize, 24);
      assert.strictEqual(layout.alignment, 8);
      assert.strictEqual(layout.paddingBytes, 11); // 7 pad + 4 tail pad
      assert.strictEqual(layout.cacheLines, 1);
      assert.ok(layout.recommendation, 'Should provide optimization recommendation');
      assert.strictEqual(layout.optimizedSize, 16); // Reordered: double (8) + int (4) + char (1) + 3 pad = 16
    });

    it('should handle packed structs with 0 padding', () => {
      const fields = [
        { type: 'char', name: 'a' },
        { type: 'double', name: 'b' },
        { type: 'int', name: 'c' }
      ];

      const layout = calculateStructLayout('PackedStruct', fields, { isPacked: true });
      assert.strictEqual(layout.totalSize, 13); // 1 + 8 + 4
      assert.strictEqual(layout.alignment, 1);
      assert.strictEqual(layout.paddingBytes, 0);
    });

    it('should calculate cache-lines for structures over 64 bytes', () => {
      const fields = [
        { type: 'double[10]', name: 'data' } // 80 bytes
      ];

      const layout = calculateStructLayout('LargeBuffer', fields);
      assert.strictEqual(layout.totalSize, 80);
      assert.strictEqual(layout.cacheLines, 2); // 80 bytes spans 2 64-byte cache lines
    });
  });

  describe('extractStructAtPosition', () => {
    it('should extract struct definition around cursor offset', () => {
      const code = `
#include <iostream>

struct Particle {
    float x;
    float y;
    float z;
    double mass;
};

int main() { return 0; }
`;
      const offset = code.indexOf('float y;');
      const extracted = extractStructAtPosition(code, offset);

      assert.ok(extracted);
      assert.strictEqual(extracted?.name, 'Particle');
      assert.strictEqual(extracted?.fields.length, 4);
      assert.strictEqual(extracted?.fields[0].name, 'x');
      assert.strictEqual(extracted?.fields[3].name, 'mass');
    });

    it('should capture array dimensions on struct fields and calculate correct size', () => {
      const code = `
struct Buffer {
    char header[16];
    int values[10];
    double matrix[2][4];
};
`;
      const extracted = extractStructAtPosition(code, 15);
      assert.ok(extracted);
      assert.strictEqual(extracted?.name, 'Buffer');
      assert.strictEqual(extracted?.fields.length, 3);
      assert.strictEqual(extracted?.fields[0].type, 'char[16]');
      assert.strictEqual(extracted?.fields[1].type, 'int[10]');
      assert.strictEqual(extracted?.fields[2].type, 'double[2][4]');

      const layout = calculateStructLayout('Buffer', extracted.fields);
      // header: 16B (offset 0)
      // values: 40B (offset 16, alignment 4)
      // matrix: 64B (offset 56, alignment 8)
      // totalSize: 120B
      assert.strictEqual(layout.totalSize, 120);
    });

    it('should correctly scope #pragma pack to wrapped struct and preserve natural alignment on following structs', () => {
      const code = `
#pragma pack(push, 1)
struct PackedHeader {
    char flag;
    int payloadSize;
};
#pragma pack(pop)

struct StandardHeader {
    char flag;
    int payloadSize;
};
`;
      const packedOffset = code.indexOf('PackedHeader') + 2;
      const packed = extractStructAtPosition(code, packedOffset);
      assert.ok(packed);
      assert.strictEqual(packed?.name, 'PackedHeader');
      assert.strictEqual(packed?.isPacked, true);
      assert.strictEqual(packed?.maxPackAlignment, 1);
      const packedLayout = calculateStructLayout(packed.name, packed.fields, {
        isPacked: packed.isPacked,
        maxPackAlignment: packed.maxPackAlignment
      });
      assert.strictEqual(packedLayout.totalSize, 5); // 1 + 4 (no padding)

      const normalOffset = code.indexOf('StandardHeader') + 2;
      const normal = extractStructAtPosition(code, normalOffset);
      assert.ok(normal);
      assert.strictEqual(normal?.name, 'StandardHeader');
      assert.strictEqual(normal?.isPacked, false);
      const normalLayout = calculateStructLayout(normal.name, normal.fields, {
        isPacked: normal.isPacked,
        maxPackAlignment: normal.maxPackAlignment
      });
      assert.strictEqual(normalLayout.totalSize, 8); // 1 + 3 pad + 4
      assert.strictEqual(normalLayout.paddingBytes, 3);
    });

    it('should return null when cursor is outside struct definition', () => {
      const code = `
struct Foo { int a; };
int x = 42;
`;
      const offset = code.indexOf('int x');
      const extracted = extractStructAtPosition(code, offset);
      assert.strictEqual(extracted, null);
    });
  });

  describe('generateLayoutAsciiDiagram and Markdown', () => {
    it('should render ascii diagram with field offsets and padding', () => {
      const fields = [
        { type: 'char', name: 'c' },
        { type: 'int', name: 'i' }
      ];
      const layout = calculateStructLayout('Simple', fields);
      const diagram = generateLayoutAsciiDiagram(layout);

      assert.ok(diagram.includes('Simple'));
      assert.ok(diagram.includes('░░ PAD (3 bytes)'));
      assert.ok(diagram.includes('■ c'));
      assert.ok(diagram.includes('■ i'));
    });

    it('should generate markdown card with cache line and warning indicators', () => {
      const fields = [
        { type: 'char', name: 'c' },
        { type: 'int', name: 'i' }
      ];
      const layout = calculateStructLayout('Simple', fields);
      const md = generateLayoutMarkdown(layout);

      assert.ok(md.value.includes('### Memory Layout: `Simple`'));
      assert.ok(md.value.includes('Offset'));
    });
  });

  describe('findMatchingBrace', () => {
    it('should find matching closing brace across comments and strings', () => {
      const snippet = '{ int a = 1; /* } */ std::string s = "}"; // }\n }';
      const openIdx = snippet.indexOf('{');
      const closeIdx = findMatchingBrace(snippet, openIdx);
      assert.strictEqual(closeIdx, snippet.length - 1);
    });

    it('should handle nested braces correctly', () => {
      const snippet = '{ void fn() { int x = 0; } int y; }';
      const openIdx = 0;
      const closeIdx = findMatchingBrace(snippet, openIdx);
      assert.strictEqual(closeIdx, snippet.length - 1);
    });
  });

  describe('parseFieldsFromBody', () => {
    it('should strip default initializers, inline comments, and attributes', () => {
      const body = `
        [[no_unique_address]] GridUnitType unit = GridUnitType::Auto; // comment
        double value = 0.0;
        void reset() { value = 0; }
        public:
        int flags{0};
      `;
      const fields = parseFieldsFromBody(body);
      assert.strictEqual(fields.length, 3);
      assert.strictEqual(fields[0].name, 'unit');
      assert.strictEqual(fields[0].type, 'GridUnitType');
      assert.strictEqual(fields[1].name, 'value');
      assert.strictEqual(fields[1].type, 'double');
      assert.strictEqual(fields[2].name, 'flags');
      assert.strictEqual(fields[2].type, 'int');
    });
  });

  describe('findStructByName', () => {
    it('should locate struct by identifier anywhere in document text', () => {
      const code = `
        namespace ide {
          struct GridLength {
            GridUnitType unit = GridUnitType::Auto;
            double value = 0.0;
          };
        }
      `;
      const parsed = findStructByName(code, 'GridLength');
      assert.ok(parsed);
      assert.strictEqual(parsed?.name, 'GridLength');
      assert.strictEqual(parsed?.fields.length, 2);
      assert.strictEqual(parsed?.fields[0].name, 'unit');
      assert.strictEqual(parsed?.fields[1].name, 'value');
    });

    it('should return null when struct name does not exist', () => {
      const code = `struct Other { int x; };`;
      assert.strictEqual(findStructByName(code, 'GridLength'), null);
    });

    it('should match structs and classes with final, inheritance, and attributes', () => {
      const code = `
        class [[nodiscard]] Widget final : public BaseWidget {
          int width;
          int height;
        };
      `;
      const parsed = findStructByName(code, 'Widget');
      assert.ok(parsed);
      assert.strictEqual(parsed?.name, 'Widget');
      assert.strictEqual(parsed?.fields.length, 2);
    });

    it('should match structs with alignas and templates', () => {
      const code = `
        template <typename T>
        struct alignas(16) AlignedBuffer {
          int size;
          void* ptr;
        };
      `;
      const parsed = findStructByName(code, 'AlignedBuffer');
      assert.ok(parsed);
      assert.strictEqual(parsed?.name, 'AlignedBuffer');
      assert.strictEqual(parsed?.structAlignment, 16);
      assert.strictEqual(parsed?.fields.length, 2);
    });

    it('should not match forward declarations without body', () => {
      const code = `
        class ForwardDeclared;
        struct OtherStruct { int a; };
      `;
      assert.strictEqual(findStructByName(code, 'ForwardDeclared'), null);
    });

    it('should not detect functions returning structs, list-initialized variables, or enum classes as struct definitions', () => {
      const code = `
        struct Foo get_foo() {
            int x = 10;
            return Foo{x};
        }
        enum class Color { Red, Green, Blue };
        struct Point p = { 1, 2 };
        struct Point p2{ 1, 2 };
      `;
      assert.strictEqual(findStructByName(code, 'Foo'), null);
      assert.strictEqual(findStructByName(code, 'Color'), null);
      assert.strictEqual(findStructByName(code, 'Point'), null);
    });

    it('should calculate aligned struct layout with structAlignment', () => {
      const fields = [
        { type: 'int', name: 'x' },
        { type: 'int', name: 'y' }
      ];
      // 8 bytes of fields with alignas(16) -> totalSize must be padded to 16 bytes
      const layout = calculateStructLayout('AlignedVec', fields, {
        isPacked: false,
        structAlignment: 16
      });
      assert.strictEqual(layout.alignment, 16);
      assert.strictEqual(layout.totalSize, 16);
      assert.strictEqual(layout.paddingBytes, 8);
    });
  });

  describe('resolveStructDefinition and Navigation across files', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-cpp-pro-layout-test-'));
    });

    afterEach(() => {
      (vscode.window as any).activeTextEditor = undefined;
      (vscode.window as any).lastWarningMessage = undefined;
      (vscode.window as any).lastInformationMessage = undefined;
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('should recursively resolve struct definition from included header in a non-definition source file', async () => {
      const headerPath = path.join(tempDir, 'widget.h');
      const headerContent = `
#pragma once
class Widget final {
public:
    int width;
    int height;
    void* handle;
};
`;
      fs.writeFileSync(headerPath, headerContent, 'utf-8');

      const srcPath = path.join(tempDir, 'main.cpp');
      const srcContent = `
#include "widget.h"

int main() {
    Widget w;
    return 0;
}
`;
      fs.writeFileSync(srcPath, srcContent, 'utf-8');

      const srcDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(srcPath));
      const widgetOffset = srcContent.indexOf('Widget w');
      const pos = srcDoc.positionAt(widgetOffset + 2);

      const resolved = await resolveStructDefinition(srcDoc, pos, 'Widget');
      assert.ok(resolved, 'Should resolve Widget from widget.h');
      assert.strictEqual(resolved?.parsed.name, 'Widget');
      assert.strictEqual(resolved?.parsed.fields.length, 3);
      assert.strictEqual(resolved?.layout.totalSize, 16);
      assert.ok(resolved?.documentUri.fsPath.endsWith('widget.h'));
    });

    it('should resolve struct transitively through nested include headers', async () => {
      const baseHeaderPath = path.join(tempDir, 'base_types.h');
      fs.writeFileSync(
        baseHeaderPath,
        `
#pragma once
struct ColorRGBA {
    uint8_t r;
    uint8_t g;
    uint8_t b;
    uint8_t a;
};
`,
        'utf-8'
      );

      const midHeaderPath = path.join(tempDir, 'graphics.h');
      fs.writeFileSync(
        midHeaderPath,
        `
#pragma once
#include "base_types.h"
`,
        'utf-8'
      );

      const srcPath = path.join(tempDir, 'app.cpp');
      const srcContent = `
#include "graphics.h"
void render() {
    ColorRGBA color;
}
`;
      fs.writeFileSync(srcPath, srcContent, 'utf-8');

      const srcDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(srcPath));
      const colorOffset = srcContent.indexOf('ColorRGBA color');
      const pos = srcDoc.positionAt(colorOffset + 3);

      const resolved = await resolveStructDefinition(srcDoc, pos, 'ColorRGBA');
      assert.ok(resolved, 'Should resolve ColorRGBA transitively from base_types.h');
      assert.strictEqual(resolved?.parsed.name, 'ColorRGBA');
      assert.strictEqual(resolved?.layout.totalSize, 4);
      assert.ok(resolved?.documentUri.fsPath.endsWith('base_types.h'));
    });

    it('should navigate to definition and render diagram when inspectCurrentStruct is invoked', async () => {
      const headerPath = path.join(tempDir, 'player.h');
      fs.writeFileSync(
        headerPath,
        `
struct Player {
    int id;
    float health;
};
`,
        'utf-8'
      );

      const srcPath = path.join(tempDir, 'game.cpp');
      const srcContent = `
#include "player.h"
Player p;
`;
      fs.writeFileSync(srcPath, srcContent, 'utf-8');

      const srcDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(srcPath));
      const playerOffset = srcContent.indexOf('Player p');
      const pos = srcDoc.positionAt(playerOffset + 2);

      const inspector = new MemoryLayoutInspector();
      try {
        const layout = await inspector.inspectCurrentStruct(
          srcDoc.uri.toString(),
          pos.line,
          pos.character,
          'Player'
        );
        assert.ok(layout);
        assert.strictEqual(layout?.name, 'Player');
        assert.strictEqual(layout?.totalSize, 8);

        // Verify active text editor was navigated to player.h and selection applied
        const activeEditor = vscode.window.activeTextEditor;
        assert.ok(activeEditor);
        assert.ok(activeEditor?.document.fileName.endsWith('player.h'));
        assert.strictEqual(activeEditor?.selection.start.line, 1);
        assert.ok((activeEditor as unknown as Record<string, unknown>).lastRevealedRange);
      } finally {
        inspector.dispose();
      }
    });

    it('should show specific warning message when struct definition cannot be found', async () => {
      const srcPath = path.join(tempDir, 'test_missing.cpp');
      const srcContent = `
void test() {
    UnknownEntity e;
}
`;
      fs.writeFileSync(srcPath, srcContent, 'utf-8');

      const srcDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(srcPath));
      const offset = srcContent.indexOf('UnknownEntity');
      const pos = srcDoc.positionAt(offset + 2);

      // Create editor for active doc
      await vscode.window.showTextDocument(srcDoc, { selection: new vscode.Range(pos, pos) });

      const inspector = new MemoryLayoutInspector();
      try {
        const layout = await inspector.inspectCurrentStruct();
        assert.strictEqual(layout, null);
        assert.strictEqual(
          (vscode.window as any).lastWarningMessage,
          "C/C++ Pro: Definition for 'UnknownEntity' could not be found. Did you mean to create one?"
        );
      } finally {
        inspector.dispose();
      }
    });

    it('should show generic placement message when cursor is on whitespace or punctuation', async () => {
      const srcPath = path.join(tempDir, 'test_empty.cpp');
      const srcContent = `
// Just empty lines and semicolons
;
;
`;
      fs.writeFileSync(srcPath, srcContent, 'utf-8');

      const srcDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(srcPath));
      const pos = new vscode.Position(2, 0);

      await vscode.window.showTextDocument(srcDoc, { selection: new vscode.Range(pos, pos) });

      const inspector = new MemoryLayoutInspector();
      try {
        const layout = await inspector.inspectCurrentStruct();
        assert.strictEqual(layout, null);
        assert.strictEqual(
          (vscode.window as any).lastInformationMessage,
          'C/C++ Pro: Place cursor inside a struct or class to inspect memory layout.'
        );
      } finally {
        inspector.dispose();
      }
    });

    it('should accept array encoded arguments from markdown command links', async () => {
      const headerPath = path.join(tempDir, 'matrix.h');
      fs.writeFileSync(
        headerPath,
        `
struct Matrix4x4 {
    float m[16];
};
`,
        'utf-8'
      );

      const srcPath = path.join(tempDir, 'render.cpp');
      const srcContent = `
#include "matrix.h"
Matrix4x4 mat;
`;
      fs.writeFileSync(srcPath, srcContent, 'utf-8');

      const srcDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(srcPath));
      const offset = srcContent.indexOf('Matrix4x4 mat');
      const pos = srcDoc.positionAt(offset);

      const inspector = new MemoryLayoutInspector();
      try {
        const args = [srcDoc.uri.toString(), pos.line, pos.character, 'Matrix4x4'];
        const layout = await inspector.inspectCurrentStruct(args);
        assert.ok(layout);
        assert.strictEqual(layout?.name, 'Matrix4x4');
        assert.strictEqual(layout?.totalSize, 64);
      } finally {
        inspector.dispose();
      }
    });

    it('should support object argument with documentUri, position, and structName', async () => {
      const headerPath = path.join(tempDir, 'entity.h');
      fs.writeFileSync(
        headerPath,
        `#pragma once\nstruct Entity {\n    int id;\n    float speed;\n};\n`,
        'utf-8'
      );

      const srcPath = path.join(tempDir, 'entity_test.cpp');
      fs.writeFileSync(
        srcPath,
        `#include "entity.h"\nvoid run() {\n    Entity e;\n}\n`,
        'utf-8'
      );

      const srcDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(srcPath));
      const entityOffset = srcDoc.getText().indexOf('Entity e');
      const pos = srcDoc.positionAt(entityOffset);

      const inspector = new MemoryLayoutInspector();
      try {
        const layout = await inspector.inspectCurrentStruct({
          documentUri: srcDoc.uri,
          position: pos,
          structName: 'Entity'
        });
        assert.ok(layout);
        assert.strictEqual(layout?.name, 'Entity');
        assert.strictEqual(layout?.totalSize, 8);
      } finally {
        inspector.dispose();
      }
    });

    it('should resolve enclosing struct when cursor is placed on a member field', async () => {
      const headerPath = path.join(tempDir, 'player_model.h');
      const content = `struct PlayerModel {\n    int health;\n    int armor;\n};\n`;
      fs.writeFileSync(headerPath, content, 'utf-8');

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(headerPath));
      const armorOffset = content.indexOf('armor');
      const pos = doc.positionAt(armorOffset);

      const fakeEditor = {
        document: doc,
        selection: new vscode.Selection(pos, pos),
        revealRange: (_range: unknown) => {}
      } as unknown as vscode.TextEditor;

      const inspector = new MemoryLayoutInspector();
      try {
        const layout = await inspector.inspectCurrentStruct(fakeEditor);
        assert.ok(layout);
        assert.strictEqual(layout?.name, 'PlayerModel');
        assert.strictEqual(layout?.totalSize, 8);
      } finally {
        inspector.dispose();
      }
    });
  });
});
