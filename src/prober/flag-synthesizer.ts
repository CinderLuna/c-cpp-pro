import * as path from 'path';
import * as fs from 'fs';
import { CompilerDetector, CompilerInfo } from './compiler-detector';
import { SystemIncludeExtractor } from './system-includes';
import { VcpkgAdvisor } from '../ecosystem/vcpkg-advisor';
import { ExternalSdkDetector } from './external-sdk-detector';
import { CMakeParser } from '../cmake/cmake-parser';

export interface SynthesisOptions {
  standard?: string;
  extraFlags?: string[];
  forceOverwrite?: boolean;
  workspaceRoot?: string;
  detectExternalSdks?: boolean;
}

export class FlagSynthesizer {
  constructor(
    private readonly detector: CompilerDetector = new CompilerDetector(),
    private readonly extractor: SystemIncludeExtractor = new SystemIncludeExtractor()
  ) {}

  /**
   * Checks if a compilation database already exists in the given workspace folder.
   */
  public hasCompilationDatabase(workspaceRoot: string): boolean {
    const candidatePaths = [
      path.join(workspaceRoot, 'compile_commands.json'),
      path.join(workspaceRoot, 'build', 'compile_commands.json'),
      path.join(workspaceRoot, 'out', 'compile_commands.json'),
      path.join(workspaceRoot, '.vscode', 'compile_commands.json')
    ];

    return candidatePaths.some((p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).size > 0;
      } catch {
        return false;
      }
    });
  }

  /**
   * Generates flags array based on the selected compiler and includes.
   */
  public async generateFlags(
    compiler: CompilerInfo,
    options: SynthesisOptions = {}
  ): Promise<string[]> {
    const includes = await this.extractor.extractSystemIncludes(compiler);
    const standard = options.standard ?? 'c++20';
    const flags: string[] = [];

    if (compiler.type === 'msvc') {
      flags.push('--driver-mode=cl');
      flags.push(`-std:${standard}`);
      flags.push('/EHsc');
      flags.push('/TP'); // Treat all files including .h headers as C++
      flags.push('/W4');

      for (const inc of includes) {
        // In clang driver mode with cl, use -I with quotes or forward slashes
        const normalized = inc.replace(/\\/g, '/');
        flags.push(`-I${normalized}`);
      }
    } else {
      flags.push('-xc++');
      flags.push(`-std=${standard}`);
      flags.push('-Wall');

      for (const inc of includes) {
        const normalized = inc.replace(/\\/g, '/');
        flags.push(`-I${normalized}`);
      }
    }

    if (options.extraFlags && options.extraFlags.length > 0) {
      flags.push(...options.extraFlags);
    }

    if (options.workspaceRoot) {
      const vcpkgRoot = VcpkgAdvisor.findVcpkgRoot(options.workspaceRoot);
      if (vcpkgRoot) {
        const vcpkgIncludes = VcpkgAdvisor.findInstalledIncludePaths(vcpkgRoot);
        for (const inc of vcpkgIncludes) {
          flags.push(`-I${inc.replace(/\\/g, '/')}`);
        }
      }

      const nodeIncludes = VcpkgAdvisor.findNodeAddonIncludePaths(options.workspaceRoot);
      for (const inc of nodeIncludes) {
        flags.push(`-I${inc.replace(/\\/g, '/')}`);
      }

      // Parse CMake include directories & definitions if CMakeLists.txt exists
      const cmakeInfo = CMakeParser.parseWorkspace(options.workspaceRoot);
      if (cmakeInfo) {
        for (const inc of cmakeInfo.includeDirectories) {
          const flag = `-I${inc.replace(/\\/g, '/')}`;
          if (!flags.includes(flag)) {
            flags.push(flag);
          }
        }
        for (const def of cmakeInfo.compileDefinitions) {
          const flag = `-D${def}`;
          if (!flags.includes(flag)) {
            flags.push(flag);
          }
        }
      }
    }

    if (options.detectExternalSdks !== false) {
      const preferredCompiler =
        compiler.type === 'gcc' || compiler.type === 'wsl-gcc'
          ? 'mingw'
          : compiler.type === 'msvc'
          ? 'msvc'
          : compiler.type;
      const sdkOpts = {
        workspaceRoot: options.workspaceRoot,
        preferredCompiler
      };
      const sdkIncludes = options.workspaceRoot
        ? ExternalSdkDetector.getWorkspaceIncludePaths(options.workspaceRoot, sdkOpts)
        : ExternalSdkDetector.getAllIncludePaths(sdkOpts);
      for (const inc of sdkIncludes) {
        const flag = `-I${inc.replace(/\\/g, '/')}`;
        if (!flags.includes(flag)) {
          flags.push(flag);
        }
      }
    }

    return flags;
  }

  /**
   * Synthesizes `compile_flags.txt` in the workspace root if no compile_commands.json exists.
   * Returns the generated file path or null if compile_commands.json exists.
   */
  public async synthesizeFlagsFile(
    workspaceRoot: string,
    options: SynthesisOptions = {}
  ): Promise<string | null> {
    if (!options.forceOverwrite && this.hasCompilationDatabase(workspaceRoot)) {
      return null;
    }

    const compiler = await this.detector.getPreferredCompiler();
    if (!compiler) {
      throw new Error('C/C++ Pro: No suitable C/C++ compiler found on the system.');
    }

    const effectiveOptions: SynthesisOptions = {
      workspaceRoot,
      ...options
    };

    const flags = await this.generateFlags(compiler, effectiveOptions);
    const targetFile = path.join(workspaceRoot, 'compile_flags.txt');

    // compile_flags.txt format: one flag per line
    const content = flags.join('\n') + '\n';
    fs.writeFileSync(targetFile, content, 'utf8');

    return targetFile;
  }
}
