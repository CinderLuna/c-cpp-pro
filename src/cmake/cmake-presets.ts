import * as path from 'path';
import * as fs from 'fs';

export interface CMakeConfigurePreset {
  name: string;
  displayName?: string;
  description?: string;
  generator?: string;
  binaryDir?: string;
  sourceDir?: string;
  cacheVariables?: Record<string, string | boolean | { type?: string; value: string | boolean }>;
  environment?: Record<string, string>;
  toolchainFile?: string;
  architecture?: string | { value?: string; strategy?: string };
}

export interface CMakeBuildPreset {
  name: string;
  displayName?: string;
  description?: string;
  configurePreset?: string;
  inheritConfigureEnvironment?: boolean;
  targets?: string | string[];
  jobs?: number;
  cleanFirst?: boolean;
}

export interface CMakeTestPreset {
  name: string;
  displayName?: string;
  description?: string;
  configurePreset?: string;
  filter?: {
    include?: { name?: string; label?: string };
    exclude?: { name?: string; label?: string };
  };
  execution?: {
    jobs?: number;
    timeout?: number;
    stopOnFailure?: boolean;
  };
}

export interface CMakePresetsData {
  version: number;
  cmakeMinimumRequired?: {
    major?: number;
    minor?: number;
    patch?: number;
  };
  configurePresets?: CMakeConfigurePreset[];
  buildPresets?: CMakeBuildPreset[];
  testPresets?: CMakeTestPreset[];
}

export class CMakePresetsParser {
  /**
   * Evaluates standard CMake Presets macro substitutions.
   */
  public static expandMacros(
    template: string,
    workspaceRoot: string,
    presetName: string,
    generator?: string
  ): string {
    const normRoot = workspaceRoot.replace(/\\/g, '/');
    const parentDir = path.dirname(normRoot).replace(/\\/g, '/');
    const baseName = path.basename(normRoot);

    let hostSystemName = 'Windows';
    if (process.platform === 'linux') hostSystemName = 'Linux';
    else if (process.platform === 'darwin') hostSystemName = 'Darwin';

    return template
      .replace(/\$\{sourceDir\}/g, normRoot)
      .replace(/\$\{sourceParentDir\}/g, parentDir)
      .replace(/\$\{sourceDirName\}/g, baseName)
      .replace(/\$\{presetName\}/g, presetName)
      .replace(/\$\{generator\}/g, generator || 'Ninja')
      .replace(/\$\{hostSystemName\}/g, hostSystemName)
      .replace(/\$\{dollar\}/g, '$')
      .replace(/\$\{env:([^}]+)\}/g, (_match, varName) => process.env[varName] || '')
      .replace(/\$\{penv:([^}]+)\}/g, (_match, varName) => process.env[varName] || '');
  }

  /**
   * Loads and merges CMakePresets.json and CMakeUserPresets.json from the workspace root.
   */
  public static loadPresets(workspaceRoot: string): {
    configurePresets: CMakeConfigurePreset[];
    buildPresets: CMakeBuildPreset[];
    testPresets: CMakeTestPreset[];
    activeConfigurePreset?: CMakeConfigurePreset;
    activeBuildPreset?: CMakeBuildPreset;
  } | null {
    const mainFile = path.join(workspaceRoot, 'CMakePresets.json');
    const userFile = path.join(workspaceRoot, 'CMakeUserPresets.json');

    if (!fs.existsSync(mainFile) && !fs.existsSync(userFile)) {
      return null;
    }

    const configureMap = new Map<string, CMakeConfigurePreset>();
    const buildMap = new Map<string, CMakeBuildPreset>();
    const testMap = new Map<string, CMakeTestPreset>();

    const ingestFile = (filePath: string) => {
      if (!fs.existsSync(filePath)) return;
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(content) as CMakePresetsData;

        if (data.configurePresets) {
          for (const p of data.configurePresets) {
            if (p.name) {
              const gen = p.generator;
              const effectiveBinaryDir = p.binaryDir
                ? this.expandMacros(p.binaryDir, workspaceRoot, p.name, gen)
                : `${workspaceRoot.replace(/\\/g, '/')}/build/${p.name}`;

              configureMap.set(p.name, {
                ...p,
                binaryDir: effectiveBinaryDir
              });
            }
          }
        }

        if (data.buildPresets) {
          for (const b of data.buildPresets) {
            if (b.name) {
              buildMap.set(b.name, b);
            }
          }
        }

        if (data.testPresets) {
          for (const t of data.testPresets) {
            if (t.name) {
              testMap.set(t.name, t);
            }
          }
        }
      } catch {
        // Skip unparseable preset files
      }
    };

    ingestFile(mainFile);
    ingestFile(userFile); // User presets override base presets

    const configurePresets = Array.from(configureMap.values());
    const buildPresets = Array.from(buildMap.values());
    const testPresets = Array.from(testMap.values());

    return {
      configurePresets,
      buildPresets,
      testPresets,
      activeConfigurePreset: configurePresets.length > 0 ? configurePresets[0] : undefined,
      activeBuildPreset: buildPresets.length > 0 ? buildPresets[0] : undefined
    };
  }

  /**
   * Resolves the compilation database path for a given configure preset.
   */
  public static getCompilationDatabasePath(
    preset: CMakeConfigurePreset,
    workspaceRoot: string
  ): string {
    const binDir = preset.binaryDir || path.join(workspaceRoot, 'build', preset.name);
    return path.join(binDir, 'compile_commands.json').replace(/\\/g, '/');
  }
}
