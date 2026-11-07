import * as path from 'path';
import * as fs from 'fs';
import { SolutionModel, VcxProjectModel, CompileCommandEntry } from './solution-models';
import { CompilerInfo } from '../prober/compiler-detector';
import { ExternalSdkDetector } from '../prober/external-sdk-detector';
import { resolveProjectReferenceDAG } from './sln-parser';
import { getPathIdentity } from '../platform/path-identity';
import { getWslCompilerArgs, isWslCompiler, toWslPath } from '../platform/wsl';

export class CompilationDatabaseGenerator {
  /**
   * Generates compilation database entries for all projects in a solution.
   */
  public generateEntries(
    solution: SolutionModel,
    projects: VcxProjectModel[],
    compiler: CompilerInfo,
    systemIncludes: string[] = [],
    activeConfiguration?: string,
    options: { includeHeaders?: boolean } = {}
  ): CompileCommandEntry[] {
    const entries: CompileCommandEntry[] = [];
    const seenFiles = new Set<string>();

    const targetConfig =
      activeConfiguration ||
      (solution.configurations.length > 0 ? solution.configurations[0].key : 'Debug|x64');

    const solutionDir = path.dirname(solution.filePath);
    const externalSdkIncludes = ExternalSdkDetector.getWorkspaceIncludePaths(solutionDir, {
      workspaceRoot: solutionDir,
      preferredCompiler: compiler.type === 'msvc' ? 'msvc' : compiler.type
    });

    for (const project of projects) {
      const projectDir = isWslCompiler(compiler)
        ? toWslPath(path.dirname(project.filePath))
        : path.dirname(project.filePath).replace(/\\/g, '/');
      const projectOpts =
        project.compileOptionsByConfig.get(targetConfig) || project.defaultCompileOptions;

      const standard = projectOpts.languageStandard || 'c++20';

      // Propagate include directories from referenced project DAG
      const refProjects = resolveProjectReferenceDAG(project, projects);
      const referencedIncludes: string[] = [];
      for (const ref of refProjects) {
        referencedIncludes.push(path.dirname(ref.filePath).replace(/\\/g, '/'));
        const refOpts =
          ref.compileOptionsByConfig.get(targetConfig) || ref.defaultCompileOptions;
        for (const inc of refOpts.includeDirectories) {
          referencedIncludes.push(inc.replace(/\\/g, '/'));
        }
      }

      // Assemble all includes: project directory + project additional includes + referenced project includes + system includes + external SDKs
      const allIncludes = Array.from(
        new Set([
          projectDir,
          ...projectOpts.includeDirectories.map((d) => d.replace(/\\/g, '/')),
          ...referencedIncludes,
          ...systemIncludes.map((s) => s.replace(/\\/g, '/')),
          ...externalSdkIncludes
        ])
      );

      const definitions = Array.from(new Set(projectOpts.preprocessorDefinitions));
      const extraOptions = projectOpts.additionalOptions || [];

      const projectFiles = [
        ...project.sourceFiles.map((f) => ({ filePath: f, isHeader: false })),
        ...(options.includeHeaders
          ? project.headerFiles.map((f) => ({ filePath: f, isHeader: true }))
          : [])
      ];

      for (const { filePath: targetFile, isHeader } of projectFiles) {
        const normalizedFile = isWslCompiler(compiler)
          ? toWslPath(targetFile)
          : targetFile.replace(/\\/g, '/');
        if (seenFiles.has(getPathIdentity(normalizedFile))) {
          continue;
        }
        seenFiles.add(getPathIdentity(normalizedFile));

        const compilerBin = compiler.path.replace(/\\/g, '/');
        const commandParts: string[] = [];
        const args: string[] = [];

        if (compiler.type === 'msvc') {
          args.push(compilerBin, '--driver-mode=cl', `/std:${standard}`, '/EHsc', '/TP', '/W4');
          commandParts.push(
            `"${compilerBin}"`,
            '--driver-mode=cl',
            `/std:${standard}`,
            '/EHsc',
            '/TP',
            '/W4'
          );

          for (const inc of allIncludes) {
            args.push(`-I${inc}`);
            commandParts.push(`-I"${inc}"`);
          }

          for (const def of definitions) {
            args.push(`-D${def}`);
            commandParts.push(`-D${def}`);
          }

          for (const opt of extraOptions) {
            args.push(opt);
            commandParts.push(opt);
          }

          args.push('/c', normalizedFile);
          commandParts.push('/c', `"${normalizedFile}"`);
        } else {
          const wslPrefix = isWslCompiler(compiler) ? getWslCompilerArgs(compiler) : [];
          args.push(compilerBin, ...wslPrefix, isHeader ? '-xc++-header' : '-xc++', `-std=${standard}`, '-Wall');
          commandParts.push(
            `"${compilerBin}"`,
            ...wslPrefix,
            isHeader ? '-xc++-header' : '-xc++',
            `-std=${standard}`,
            '-Wall'
          );

          for (const inc of allIncludes) {
            args.push(`-I${inc}`);
            commandParts.push(`-I"${inc}"`);
          }

          for (const def of definitions) {
            args.push(`-D${def}`);
            commandParts.push(`-D${def}`);
          }

          for (const opt of extraOptions) {
            args.push(opt);
            commandParts.push(opt);
          }

          args.push('-c', normalizedFile);
          commandParts.push('-c', `"${normalizedFile}"`);
        }

        entries.push({
          directory: projectDir,
          command: commandParts.join(' '),
          arguments: args,
          file: normalizedFile
        });
      }
    }

    return entries;
  }

  /**
   * Writes the generated compilation database to compile_commands.json on disk.
   */
  public async writeCompilationDatabase(
    targetFilePath: string,
    entries: CompileCommandEntry[]
  ): Promise<string> {
    await fs.promises.mkdir(path.dirname(targetFilePath), { recursive: true });
    const content = JSON.stringify(entries, null, 2) + '\n';
    await fs.promises.writeFile(targetFilePath, content, 'utf8');
    return targetFilePath;
  }
}
