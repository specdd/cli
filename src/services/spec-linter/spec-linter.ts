import fg from 'fast-glob';
import {
  basename,
  join,
  posix,
  resolve,
} from 'node:path';
import { CliError } from '../../cli-error.js';
import type {
  DirectoryCheckerDependency,
  FileExistenceDependency,
} from '../../infrastructure/file-system.js';
import type { SpecParser } from '../spec-parser/spec-parser.js';
import {
  SpecParserReadError,
  SpecParserSyntaxError,
} from '../spec-parser/spec-parser.js';

export type SpecLintRequest = {
  readonly targetDirectoryPath: string;
};

export type SpecLintSeverity = 'error' | 'warning';

export type SpecLintDiagnostic = {
  readonly severity: SpecLintSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly lineNumber?: number;
};

export type SpecLintSpecNode = {
  readonly type: 'spec';
  readonly name: string;
  readonly path: string;
  readonly directoryLevel: boolean;
  readonly diagnostics: readonly SpecLintDiagnostic[];
};

export type SpecLintDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  readonly spec: SpecLintSpecNode | null;
  readonly children: readonly SpecLintNode[];
};

export type SpecLintNode = SpecLintDirectoryNode | SpecLintSpecNode;

export type SpecLintResult = {
  readonly targetDirectoryPath: string;
  readonly ok: boolean;
  readonly filesChecked: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly diagnostics: readonly SpecLintDiagnostic[];
  readonly root: SpecLintDirectoryNode;
};

export type SpecLintPathFinder = (targetDirectoryPath: string) => Promise<readonly string[]>;

type SpecLintFileSystemDependency = DirectoryCheckerDependency & FileExistenceDependency;

type SpecLintSpecParserDependency = Pick<SpecParser, 'validateFile'>;

type SpecLintParsedSpec = {
  readonly directoryPath: string;
  readonly diagnostics: SpecLintDiagnostic[];
  readonly name: string;
  readonly path: string;
};

type MutableSpecLintDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  spec: SpecLintSpecNode | null;
  readonly children: SpecLintNode[];
  readonly directoryChildren: Map<string, MutableSpecLintDirectoryNode>;
};

export class SpecLintTargetNotFoundError extends CliError {
  public constructor(path: string) {
    super(`Spec lint target directory not found: ${path}`);
    this.name = 'SpecLintTargetNotFoundError';
  }
}

export class SpecLintTargetNotDirectoryError extends CliError {
  public constructor(path: string) {
    super(`Spec lint target path is not a directory: ${path}`);
    this.name = 'SpecLintTargetNotDirectoryError';
  }
}

export class SpecLintDiscoveryError extends CliError {
  public constructor(path: string, reason: string) {
    super(`Failed to discover SpecDD specs under ${path}: ${reason}`);
    this.name = 'SpecLintDiscoveryError';
  }
}

export class SpecLinter {
  private readonly fileSystem: SpecLintFileSystemDependency;

  private readonly specParser: SpecLintSpecParserDependency;

  private readonly findSpecPaths: SpecLintPathFinder;

  public constructor(
    fileSystem: SpecLintFileSystemDependency,
    specParser: SpecLintSpecParserDependency,
    findSpecPaths: SpecLintPathFinder = SpecLinter.findSpecPaths,
  ) {
    this.fileSystem = fileSystem;
    this.specParser = specParser;
    this.findSpecPaths = findSpecPaths;
  }

  public async lint(request: SpecLintRequest): Promise<SpecLintResult> {
    const targetDirectoryPath = resolve(request.targetDirectoryPath);

    await this.validateTargetDirectory(targetDirectoryPath);

    const relativeSpecPaths = await this.discoverSpecPaths(targetDirectoryPath);
    const parsedSpecs = await this.parseSpecs(targetDirectoryPath, relativeSpecPaths);
    const directoryLevelSpecPaths = this.directoryLevelSpecPaths(targetDirectoryPath, parsedSpecs);
    const diagnostics = parsedSpecs.flatMap((parsedSpec) => parsedSpec.diagnostics);
    const errorCount = diagnostics.filter((diagnostic) => 'error' === diagnostic.severity).length;
    const warningCount = diagnostics.filter((diagnostic) => 'warning' === diagnostic.severity).length;

    return {
      diagnostics,
      errorCount,
      filesChecked: parsedSpecs.length,
      ok: 0 === errorCount,
      root: this.buildRootNode(targetDirectoryPath, parsedSpecs, directoryLevelSpecPaths),
      targetDirectoryPath,
      warningCount,
    };
  }

  private async validateTargetDirectory(targetDirectoryPath: string): Promise<void> {
    let targetExists: boolean;
    let targetIsDirectory: boolean;

    try {
      targetExists = await this.fileSystem.exists(targetDirectoryPath);
    } catch (error) {
      throw new SpecLintDiscoveryError(targetDirectoryPath, String(error));
    }

    if (!targetExists) {
      throw new SpecLintTargetNotFoundError(targetDirectoryPath);
    }

    try {
      targetIsDirectory = await this.fileSystem.isDirectory(targetDirectoryPath);
    } catch (error) {
      throw new SpecLintDiscoveryError(targetDirectoryPath, String(error));
    }

    if (!targetIsDirectory) {
      throw new SpecLintTargetNotDirectoryError(targetDirectoryPath);
    }
  }

  private async discoverSpecPaths(targetDirectoryPath: string): Promise<readonly string[]> {
    try {
      return [
        ...(await this.findSpecPaths(targetDirectoryPath)),
      ].map((path) => this.normalizeRelativePath(path)).sort();
    } catch (error) {
      throw new SpecLintDiscoveryError(targetDirectoryPath, String(error));
    }
  }

  private async parseSpecs(
    targetDirectoryPath: string,
    relativeSpecPaths: readonly string[],
  ): Promise<readonly SpecLintParsedSpec[]> {
    const parsedSpecs: SpecLintParsedSpec[] = [];

    for (const relativePath of relativeSpecPaths) {
      const diagnostics: SpecLintDiagnostic[] = [];
      const absolutePath = join(targetDirectoryPath, ...relativePath.split('/'));

      try {
        const syntaxErrors = await this.specParser.validateFile({
          path: absolutePath,
        });

        diagnostics.push(...syntaxErrors.map((error) => this.syntaxDiagnostic(relativePath, error)));
      } catch (error) {
        diagnostics.push(this.readDiagnostic(relativePath, error));
      }

      parsedSpecs.push({
        diagnostics,
        directoryPath: posix.dirname(relativePath),
        name: posix.basename(relativePath),
        path: relativePath,
      });
    }

    return parsedSpecs;
  }

  private syntaxDiagnostic(relativePath: string, error: SpecParserSyntaxError): SpecLintDiagnostic {
    return {
      code: 'syntax',
      ...(null === error.lineNumber ? {} : {
        lineNumber: error.lineNumber,
      }),
      message: error.description,
      path: relativePath,
      severity: 'error',
    };
  }

  private readDiagnostic(relativePath: string, error: unknown): SpecLintDiagnostic {
    if (error instanceof SpecParserReadError) {
      return {
        code: 'read',
        message: error.message,
        path: relativePath,
        severity: 'error',
      };
    }

    return {
      code: 'read',
      message: String(error),
      path: relativePath,
      severity: 'error',
    };
  }

  private directoryLevelSpecPaths(
    targetDirectoryPath: string,
    parsedSpecs: readonly SpecLintParsedSpec[],
  ): Set<string> {
    const specsByDirectoryPath = this.groupSpecsByDirectoryPath(parsedSpecs);
    const directoryLevelSpecPaths = new Set<string>();

    for (const [directoryPath, specs] of specsByDirectoryPath.entries()) {
      const directoryBasename = this.directoryBasename(targetDirectoryPath, directoryPath);
      const directoryLevelSpec = this.directoryLevelSpec(directoryPath, directoryBasename, specs);

      if (null !== directoryLevelSpec) {
        directoryLevelSpecPaths.add(directoryLevelSpec.path);
      }
    }

    return directoryLevelSpecPaths;
  }

  private groupSpecsByDirectoryPath(
    parsedSpecs: readonly SpecLintParsedSpec[],
  ): ReadonlyMap<string, readonly SpecLintParsedSpec[]> {
    const specsByDirectoryPath = new Map<string, SpecLintParsedSpec[]>();

    for (const parsedSpec of parsedSpecs) {
      specsByDirectoryPath.set(parsedSpec.directoryPath, [
        ...(specsByDirectoryPath.get(parsedSpec.directoryPath) ?? []),
        parsedSpec,
      ]);
    }

    return specsByDirectoryPath;
  }

  private directoryBasename(targetDirectoryPath: string, directoryPath: string): string {
    if ('.' === directoryPath) {
      return basename(targetDirectoryPath);
    }

    return posix.basename(directoryPath);
  }

  private directoryLevelSpec(
    directoryPath: string,
    directoryBasename: string,
    specs: readonly SpecLintParsedSpec[],
  ): SpecLintParsedSpec | null {
    const exactMatch = specs.find((spec) => this.specBasename(spec) === directoryBasename);

    if (undefined !== exactMatch) {
      return exactMatch;
    }

    const lowercaseMatches = specs.filter((spec) => this.specBasename(spec).toLowerCase() === directoryBasename.toLowerCase());

    if (1 < lowercaseMatches.length) {
      const message = `Ambiguous directory-level SpecDD specs for ${directoryPath}: ${lowercaseMatches.map((spec) => spec.path).join(', ')}`;

      for (const spec of lowercaseMatches) {
        spec.diagnostics.push({
          code: 'directory-spec',
          message,
          path: spec.path,
          severity: 'error',
        });
      }

      return null;
    }

    return lowercaseMatches[0] ?? null;
  }

  private specBasename(spec: SpecLintParsedSpec): string {
    return spec.name.slice(0, -'.sdd'.length);
  }

  private buildRootNode(
    targetDirectoryPath: string,
    parsedSpecs: readonly SpecLintParsedSpec[],
    directoryLevelSpecPaths: ReadonlySet<string>,
  ): SpecLintDirectoryNode {
    const root = this.createMutableDirectoryNode('.', basename(targetDirectoryPath));

    for (const parsedSpec of parsedSpecs) {
      const directoryNode = this.directoryNode(root, parsedSpec.directoryPath);
      const isDirectoryLevel = directoryLevelSpecPaths.has(parsedSpec.path);
      const specNode = this.specNode(parsedSpec, isDirectoryLevel);

      if (isDirectoryLevel) {
        directoryNode.spec = specNode;

        continue;
      }

      directoryNode.children.push(specNode);
    }

    return this.toDirectoryNode(root);
  }

  private directoryNode(
    root: MutableSpecLintDirectoryNode,
    directoryPath: string,
  ): MutableSpecLintDirectoryNode {
    if ('.' === directoryPath) {
      return root;
    }

    const parentPath = posix.dirname(directoryPath);
    const parentNode = this.directoryNode(root, parentPath);
    const existingNode = parentNode.directoryChildren.get(directoryPath);

    if (undefined !== existingNode) {
      return existingNode;
    }

    const directoryNode = this.createMutableDirectoryNode(directoryPath, posix.basename(directoryPath));

    parentNode.directoryChildren.set(directoryPath, directoryNode);
    parentNode.children.push(directoryNode);

    return directoryNode;
  }

  private specNode(parsedSpec: SpecLintParsedSpec, directoryLevel: boolean): SpecLintSpecNode {
    return {
      diagnostics: [
        ...parsedSpec.diagnostics,
      ],
      directoryLevel,
      name: parsedSpec.name,
      path: parsedSpec.path,
      type: 'spec',
    };
  }

  private createMutableDirectoryNode(path: string, name: string): MutableSpecLintDirectoryNode {
    return {
      children: [],
      directoryChildren: new Map(),
      name,
      path,
      spec: null,
      type: 'directory',
    };
  }

  private toDirectoryNode(node: MutableSpecLintDirectoryNode): SpecLintDirectoryNode {
    return {
      children: node.children.sort((left, right) => left.path.localeCompare(right.path)).map((child) => {
        if ('directory' === child.type) {
          return this.toDirectoryNode(child as MutableSpecLintDirectoryNode);
        }

        return child;
      }),
      name: node.name,
      path: node.path,
      spec: node.spec,
      type: 'directory',
    };
  }

  private normalizeRelativePath(path: string): string {
    const normalizedPath = path.replaceAll('\\', '/');

    if (normalizedPath.startsWith('./')) {
      return normalizedPath.slice(2);
    }

    return normalizedPath;
  }

  private static async findSpecPaths(targetDirectoryPath: string): Promise<readonly string[]> {
    return fg('**/*.sdd', {
      cwd: targetDirectoryPath,
      dot: true,
      onlyFiles: true,
      unique: true,
    });
  }
}
