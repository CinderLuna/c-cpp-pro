import * as path from 'path';
import * as fs from 'fs';
import { CMakeProjectInfo, CMakeTargetInfo } from './cmake-models';

export interface FileApiTargetArtifact {
  path: string;
}

export interface FileApiSourceGroup {
  name: string;
  sourceIndexes: number[];
}

export interface FileApiCompileGroup {
  language: string;
  compileCommandFragments?: Array<{ fragment: string }>;
  includes?: Array<{ path: string; isSystem?: boolean }>;
  preprocessorDefinitions?: Array<{ define: string }>;
  sysroot?: { path: string };
}

export interface FileApiTarget {
  name: string;
  type: string;
  artifacts?: FileApiTargetArtifact[];
  sources?: Array<{ path: string; compileGroupIndex?: number }>;
  sourceGroups?: FileApiSourceGroup[];
  compileGroups?: FileApiCompileGroup[];
}

export interface FileApiIndexReply {
  'codemodel-v2'?: { jsonFile: string };
  'cache-v2'?: { jsonFile: string };
  'toolchains-v1'?: { jsonFile: string };
  'cmakeFiles-v1'?: { jsonFile: string };
}

export interface FileApiIndex {
  reply: FileApiIndexReply;
}

export interface FileApiCodeModelConfiguration {
  name: string;
  targets: Array<{ name: string; jsonFile: string }>;
}

export interface FileApiCodeModel {
  configurations: FileApiCodeModelConfiguration[];
}

export interface FileApiToolchains {
  toolchains?: Array<{
    language: string;
    compiler?: {
      path?: string;
      id?: string;
      version?: string;
      target?: string;
    };
  }>;
}

export interface FileApiCacheEntry {
  name: string;
  type: string;
  value: string;
  properties?: Array<{ name: string; value: string }>;
}

export interface FileApiCache {
  entries: FileApiCacheEntry[];
}

export interface FileApiParsedResult {
  project: CMakeProjectInfo;
  executableTargets: Array<{ name: string; binaryPath: string; workingDirectory?: string }>;
  toolchains?: Record<string, { path: string; id: string; version: string; targetTriple?: string }>;
  cacheEntries?: Record<string, string>;
  rawCodeModel?: FileApiCodeModel;
}

export class CMakeFileApiReader {
  /**
   * Scans common build directory locations within a workspace for CMake FileAPI reply directories.
   * Looks for .cmake/api/v1/reply/index-*.json.
   */
  public static findReplyDirectory(workspaceRoot: string, customBuildDir?: string): string | null {
    const candidates: string[] = [];

    if (customBuildDir && customBuildDir.trim().length > 0) {
      const resolved = path.isAbsolute(customBuildDir)
        ? customBuildDir
        : path.join(workspaceRoot, customBuildDir);
      candidates.push(path.join(resolved, '.cmake', 'api', 'v1', 'reply'));
    }

    // Standard build directories
    candidates.push(
      path.join(workspaceRoot, 'build', '.cmake', 'api', 'v1', 'reply'),
      path.join(workspaceRoot, 'out', '.cmake', 'api', 'v1', 'reply'),
      path.join(workspaceRoot, '.cmake', 'api', 'v1', 'reply')
    );

    // Look for subfolders in build/ (e.g. build/Debug, build/Release, build/x64-Debug)
    const buildRoot = path.join(workspaceRoot, 'build');
    if (fs.existsSync(buildRoot)) {
      try {
        const subdirs = fs.readdirSync(buildRoot, { withFileTypes: true });
        for (const sub of subdirs) {
          if (sub.isDirectory()) {
            candidates.push(path.join(buildRoot, sub.name, '.cmake', 'api', 'v1', 'reply'));
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    for (const cand of candidates) {
      if (fs.existsSync(cand) && this.findLatestIndexFile(cand) !== null) {
        return cand.replace(/\\/g, '/');
      }
    }

    return null;
  }

  /**
   * Finds the latest index-*.json file in the reply directory.
   */
  public static findLatestIndexFile(replyDir: string): string | null {
    if (!fs.existsSync(replyDir)) return null;

    try {
      const files = fs.readdirSync(replyDir);
      const indexFiles = files.filter((f) => /^index-.*\.json$/i.test(f));
      if (indexFiles.length === 0) return null;

      // Sort by file modification time descending
      indexFiles.sort((a, b) => {
        const statA = fs.statSync(path.join(replyDir, a));
        const statB = fs.statSync(path.join(replyDir, b));
        return statB.mtimeMs - statA.mtimeMs;
      });

      return path.join(replyDir, indexFiles[0]).replace(/\\/g, '/');
    } catch {
      return null;
    }
  }

  /**
   * Ingests FileAPI reply artifacts and transforms them into a structured FileApiParsedResult.
   */
  public static parseReply(workspaceRoot: string, replyDir: string): FileApiParsedResult | null {
    const indexFilePath = this.findLatestIndexFile(replyDir);
    if (!indexFilePath) return null;

    try {
      const indexContent = fs.readFileSync(indexFilePath, 'utf8');
      const indexObj = JSON.parse(indexContent) as FileApiIndex;
      const reply = indexObj.reply;

      if (!reply || !reply['codemodel-v2']) {
        return null;
      }

      const codeModelPath = path.join(replyDir, reply['codemodel-v2'].jsonFile);
      if (!fs.existsSync(codeModelPath)) return null;

      const codeModelContent = fs.readFileSync(codeModelPath, 'utf8');
      const codeModel = JSON.parse(codeModelContent) as FileApiCodeModel;

      if (!codeModel.configurations || codeModel.configurations.length === 0) {
        return null;
      }

      // Read active or first configuration
      const config = codeModel.configurations[0];
      const parsedTargets: CMakeTargetInfo[] = [];
      const executableTargets: Array<{ name: string; binaryPath: string; workingDirectory?: string }> = [];
      const allGlobalIncludes = new Set<string>();
      const allGlobalDefs = new Set<string>();

      // Build directory is the parent of .cmake/
      const buildDir = path.resolve(replyDir, '..', '..', '..');

      for (const targetRef of config.targets) {
        const targetJsonPath = path.join(replyDir, targetRef.jsonFile);
        if (!fs.existsSync(targetJsonPath)) continue;

        try {
          const targetContent = fs.readFileSync(targetJsonPath, 'utf8');
          const targetObj = JSON.parse(targetContent) as FileApiTarget;

          const targetTypeLower = (targetObj.type || '').toLowerCase();
          let normType: 'executable' | 'library' | 'interface' | 'custom' = 'custom';
          if (targetTypeLower.includes('executable')) {
            normType = 'executable';
          } else if (targetTypeLower.includes('library')) {
            if (targetTypeLower.includes('interface')) {
              normType = 'interface';
            } else {
              normType = 'library';
            }
          }

          const targetSources: string[] = [];
          if (targetObj.sources) {
            for (const s of targetObj.sources) {
              const fullSrc = path.isAbsolute(s.path)
                ? s.path
                : path.join(workspaceRoot, s.path);
              targetSources.push(fullSrc.replace(/\\/g, '/'));
            }
          }

          const targetIncludes: string[] = [];
          const targetDefs: string[] = [];

          if (targetObj.compileGroups) {
            for (const cg of targetObj.compileGroups) {
              if (cg.includes) {
                for (const inc of cg.includes) {
                  if (inc.path) {
                    const normInc = inc.path.replace(/\\/g, '/');
                    targetIncludes.push(normInc);
                    allGlobalIncludes.add(normInc);
                  }
                }
              }
              if (cg.preprocessorDefinitions) {
                for (const def of cg.preprocessorDefinitions) {
                  if (def.define) {
                    targetDefs.push(def.define);
                    allGlobalDefs.add(def.define);
                  }
                }
              }
            }
          }

          parsedTargets.push({
            name: targetObj.name,
            type: normType,
            sourceFiles: targetSources,
            includeDirectories: Array.from(new Set(targetIncludes)),
            compileDefinitions: Array.from(new Set(targetDefs))
          });

          // Record executable targets for launch and debugging
          if (normType === 'executable' && targetObj.artifacts && targetObj.artifacts.length > 0) {
            const rawArtifact = targetObj.artifacts[0].path;
            const fullArtifact = path.isAbsolute(rawArtifact)
              ? rawArtifact
              : path.join(buildDir, rawArtifact);

            executableTargets.push({
              name: targetObj.name,
              binaryPath: fullArtifact.replace(/\\/g, '/'),
              workingDirectory: buildDir.replace(/\\/g, '/')
            });
          }
        } catch {
          // Skip corrupted target file
        }
      }

      // Optional: Parse toolchains-v1
      let toolchains: Record<string, { path: string; id: string; version: string; targetTriple?: string }> | undefined;
      if (reply['toolchains-v1']) {
        const tcPath = path.join(replyDir, reply['toolchains-v1'].jsonFile);
        if (fs.existsSync(tcPath)) {
          try {
            const tcContent = fs.readFileSync(tcPath, 'utf8');
            const tcObj = JSON.parse(tcContent) as FileApiToolchains;
            if (tcObj.toolchains) {
              toolchains = {};
              for (const tc of tcObj.toolchains) {
                if (tc.language && tc.compiler && tc.compiler.path) {
                  toolchains[tc.language] = {
                    path: tc.compiler.path.replace(/\\/g, '/'),
                    id: tc.compiler.id || '',
                    version: tc.compiler.version || '',
                    targetTriple: tc.compiler.target
                  };
                }
              }
            }
          } catch {
            // Ignore toolchain parsing error
          }
        }
      }

      // Optional: Parse cache-v2
      let cacheEntries: Record<string, string> | undefined;
      if (reply['cache-v2']) {
        const cachePath = path.join(replyDir, reply['cache-v2'].jsonFile);
        if (fs.existsSync(cachePath)) {
          try {
            const cacheContent = fs.readFileSync(cachePath, 'utf8');
            const cacheObj = JSON.parse(cacheContent) as FileApiCache;
            if (cacheObj.entries) {
              cacheEntries = {};
              for (const ent of cacheObj.entries) {
                if (ent.name) {
                  cacheEntries[ent.name] = ent.value;
                }
              }
            }
          } catch {
            // Ignore cache parsing error
          }
        }
      }

      const project: CMakeProjectInfo = {
        workspaceRoot: workspaceRoot.replace(/\\/g, '/'),
        cmakeListsPath: path.join(workspaceRoot, 'CMakeLists.txt').replace(/\\/g, '/'),
        includeDirectories: Array.from(allGlobalIncludes),
        globalIncludeDirectories: Array.from(allGlobalIncludes),
        compileDefinitions: Array.from(allGlobalDefs),
        globalCompileDefinitions: Array.from(allGlobalDefs),
        targets: parsedTargets,
        subdirectories: []
      };

      return {
        project,
        executableTargets,
        toolchains,
        cacheEntries,
        rawCodeModel: codeModel
      };
    } catch {
      return null;
    }
  }
}
