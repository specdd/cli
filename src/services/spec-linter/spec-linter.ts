import fg from 'fast-glob';
import {
  basename,
  join,
  posix,
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
import {
  type SpecDirectoryContextAmbiguity,
  type SpecDirectoryContextMatch,
} from '../spec-directory-context/spec-directory-context.js';
import {
  SpecTargetContext,
  SpecTargetContextDiscoveryError,
  SpecTargetContextRootNotDirectoryError,
  SpecTargetContextRootNotFoundError,
  type SpecTargetContextTarget,
  type SpecTargetContextTargetSpecAmbiguity,
  SpecTargetContextTargetNotFoundError,
} from '../spec-target-context/spec-target-context.js';

export type SpecLintRequest = {
  readonly rootDirectoryPath?: string;
  readonly targetDirectoryPath?: string;
  readonly targetPath?: string;
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
  readonly specs: readonly SpecLintSpecNode[];
  readonly children: readonly SpecLintNode[];
};

export type SpecLintNode = SpecLintDirectoryNode | SpecLintSpecNode;

export type SpecLintResult = {
  readonly rootDirectoryPath: string;
  readonly targetDirectoryPath: string;
  readonly targetPath: string;
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

type SpecLintTarget = SpecTargetContextTarget;

type SpecLintTargetPlan = {
  readonly relativeSpecPaths: readonly string[];
  readonly rootDirectoryPath: string;
  readonly target: SpecLintTarget;
  readonly targetSpecAmbiguities: readonly SpecTargetContextTargetSpecAmbiguity[];
};

type SpecLintTargetContextDependency = Pick<
  SpecTargetContext,
  | 'contextSpecPaths'
  | 'directoryContextMatches'
  | 'normalizeRelativePath'
  | 'recursiveSpecPaths'
  | 'resolvePreferredRootDirectoryPath'
  | 'resolveTarget'
  | 'targetSpecPaths'
  | 'uniqueSortedSpecPaths'
>;

type MutableSpecLintNode = MutableSpecLintDirectoryNode | SpecLintSpecNode;

type MutableSpecLintDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  readonly specs: SpecLintSpecNode[];
  readonly children: MutableSpecLintNode[];
  readonly directoryChildren: Map<string, MutableSpecLintDirectoryNode>;
};

export class SpecLintTargetNotFoundError extends CliError {
  public constructor(path: string) {
    super(`Spec lint target not found: ${path}`);
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
  private readonly specParser: SpecLintSpecParserDependency;

  private readonly findSpecPaths: SpecLintPathFinder;

  private readonly targetContext: SpecLintTargetContextDependency;

  public constructor(
    fileSystem: SpecLintFileSystemDependency,
    specParser: SpecLintSpecParserDependency,
    findSpecPaths: SpecLintPathFinder = SpecLinter.findSpecPaths,
    targetContext: SpecLintTargetContextDependency = new SpecTargetContext(fileSystem),
  ) {
    this.specParser = specParser;
    this.findSpecPaths = findSpecPaths;
    this.targetContext = targetContext;
  }

  public async lint(request: SpecLintRequest): Promise<SpecLintResult> {
    const target = await this.resolveTarget(request.targetPath ?? request.targetDirectoryPath ?? '.');
    const rootDirectoryPath = await this.resolveRootDirectoryPath(request.rootDirectoryPath, target);
    const targetPlan = await this.discoverTargetPlan(rootDirectoryPath, target);
    const parsedSpecs = await this.parseSpecs(rootDirectoryPath, targetPlan.relativeSpecPaths);

    this.addTargetSpecDiagnostics(parsedSpecs, targetPlan.targetSpecAmbiguities);

    const directoryContextMatches = await this.directoryContextMatches(rootDirectoryPath, parsedSpecs);
    const diagnostics = parsedSpecs.flatMap((parsedSpec) => parsedSpec.diagnostics);
    const errorCount = diagnostics.filter((diagnostic) => 'error' === diagnostic.severity).length;
    const warningCount = diagnostics.filter((diagnostic) => 'warning' === diagnostic.severity).length;

    return {
      diagnostics,
      errorCount,
      filesChecked: parsedSpecs.length,
      ok: 0 === errorCount,
      root: this.buildRootNode(rootDirectoryPath, parsedSpecs, directoryContextMatches),
      rootDirectoryPath,
      targetDirectoryPath: target.directoryPath,
      targetPath: target.path,
      warningCount,
    };
  }

  private async resolveTarget(targetPath: string): Promise<SpecLintTarget> {
    try {
      return await this.targetContext.resolveTarget(targetPath);
    } catch (error) {
      this.raiseTargetContextError(error);
      throw error;
    }
  }

  private async resolveRootDirectoryPath(
    requestedRootDirectoryPath: string | undefined,
    target: SpecLintTarget,
  ): Promise<string> {
    try {
      return await this.targetContext.resolvePreferredRootDirectoryPath(requestedRootDirectoryPath, target);
    } catch (error) {
      this.raiseTargetContextError(error);
      throw error;
    }
  }

  private async discoverSpecPaths(targetDirectoryPath: string): Promise<readonly string[]> {
    try {
      return [
        ...(await this.findSpecPaths(targetDirectoryPath)),
      ].map((path) => this.targetContext.normalizeRelativePath(path)).sort();
    } catch (error) {
      throw new SpecLintDiscoveryError(targetDirectoryPath, String(error));
    }
  }

  private async discoverTargetPlan(
    rootDirectoryPath: string,
    target: SpecLintTarget,
  ): Promise<SpecLintTargetPlan> {
    const allRelativeSpecPaths = await this.discoverSpecPaths(rootDirectoryPath);
    const contextResult = this.targetContext.contextSpecPaths(rootDirectoryPath, target.directoryPath, allRelativeSpecPaths);
    const targetSpecResult = this.targetContext.targetSpecPaths(rootDirectoryPath, target, allRelativeSpecPaths);
    const recursiveSpecPaths = 'directory' === target.kind
      ? this.targetContext.recursiveSpecPaths(rootDirectoryPath, target.path, allRelativeSpecPaths)
      : [];

    return {
      relativeSpecPaths: this.targetContext.uniqueSortedSpecPaths([
        ...contextResult.matches.map((match) => match.specPath),
        ...contextResult.ambiguities.flatMap((ambiguity) => ambiguity.specPaths),
        ...targetSpecResult.specPaths,
        ...recursiveSpecPaths,
      ]),
      rootDirectoryPath,
      target,
      targetSpecAmbiguities: targetSpecResult.ambiguities,
    };
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

  private addTargetSpecDiagnostics(
    parsedSpecs: readonly SpecLintParsedSpec[],
    ambiguities: readonly SpecTargetContextTargetSpecAmbiguity[],
  ): void {
    const parsedSpecsByPath = new Map(parsedSpecs.map((parsedSpec) => [
      parsedSpec.path,
      parsedSpec,
    ]));

    for (const ambiguity of ambiguities) {
      const message = `Ambiguous target SpecDD specs for ${ambiguity.targetPath}: ${ambiguity.specPaths.join(', ')}`;

      for (const specPath of ambiguity.specPaths) {
        parsedSpecsByPath.get(specPath)?.diagnostics.push({
          code: 'target-spec',
          message,
          path: specPath,
          severity: 'error',
        });
      }
    }
  }

  private async directoryContextMatches(
    rootDirectoryPath: string,
    parsedSpecs: readonly SpecLintParsedSpec[],
  ): Promise<readonly SpecDirectoryContextMatch[]> {
    let result;

    try {
      result = await this.targetContext.directoryContextMatches(rootDirectoryPath, parsedSpecs);
    } catch (error) {
      throw new SpecLintDiscoveryError(rootDirectoryPath, (error as SpecTargetContextDiscoveryError).reason);
    }

    this.addDirectorySpecDiagnostics(parsedSpecs, result.ambiguities);

    return result.matches;
  }

  private addDirectorySpecDiagnostics(
    parsedSpecs: readonly SpecLintParsedSpec[],
    ambiguities: readonly SpecDirectoryContextAmbiguity[],
  ): void {
    const parsedSpecsByPath = new Map(parsedSpecs.map((parsedSpec) => [
      parsedSpec.path,
      parsedSpec,
    ]));

    for (const ambiguity of ambiguities) {
      const message = `Ambiguous directory-level SpecDD specs for ${ambiguity.directoryPath}: ${ambiguity.specPaths.join(', ')}`;

      for (const specPath of ambiguity.specPaths) {
        parsedSpecsByPath.get(specPath)?.diagnostics.push({
          code: 'directory-spec',
          message,
          path: specPath,
          severity: 'error',
        });
      }
    }
  }

  private buildRootNode(
    targetDirectoryPath: string,
    parsedSpecs: readonly SpecLintParsedSpec[],
    directoryContextMatches: readonly SpecDirectoryContextMatch[],
  ): SpecLintDirectoryNode {
    const root = this.createMutableDirectoryNode('.', basename(targetDirectoryPath));
    const parsedSpecByPath = new Map(parsedSpecs.map((parsedSpec) => [
      parsedSpec.path,
      parsedSpec,
    ]));
    const directoryLevelSpecPaths = new Set(directoryContextMatches.map((match) => match.specPath));

    for (const match of directoryContextMatches) {
      const parsedSpec = parsedSpecByPath.get(match.specPath) as SpecLintParsedSpec;

      this.directoryNode(root, match.directoryPath).specs.push(this.specNode(parsedSpec, true));
    }

    for (const parsedSpec of parsedSpecs) {
      if (directoryLevelSpecPaths.has(parsedSpec.path)) {
        continue;
      }

      this.directoryNode(root, parsedSpec.directoryPath).children.push(this.specNode(parsedSpec, false));
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
      specs: [],
      type: 'directory',
    };
  }

  private toDirectoryNode(node: MutableSpecLintDirectoryNode): SpecLintDirectoryNode {
    const specs = [
      ...node.specs,
    ];

    return {
      children: node.children.sort((left, right) => left.path.localeCompare(right.path)).map((child) => {
        if ('directory' === child.type) {
          return this.toDirectoryNode(child);
        }

        return child;
      }),
      name: node.name,
      path: node.path,
      spec: specs[0] ?? null,
      specs,
      type: 'directory',
    };
  }

  private raiseTargetContextError(error: unknown): void {
    if (error instanceof SpecTargetContextTargetNotFoundError || error instanceof SpecTargetContextRootNotFoundError) {
      throw new SpecLintTargetNotFoundError(error.path);
    }

    if (error instanceof SpecTargetContextRootNotDirectoryError) {
      throw new SpecLintTargetNotDirectoryError(error.path);
    }

    if (error instanceof SpecTargetContextDiscoveryError) {
      throw new SpecLintDiscoveryError(error.path, error.reason);
    }
  }

  private static async findSpecPaths(targetDirectoryPath: string): Promise<readonly string[]> {
    return fg('**/*.sdd', {
      cwd: targetDirectoryPath,
      dot: true,
      followSymbolicLinks: false,
      onlyFiles: true,
      unique: true,
    });
  }
}
