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
import type {
  SpecDocument,
  SpecParser,
  SpecSection,
} from '../spec-parser/spec-parser.js';
import {
  type SpecDirectoryContextMatch,
} from '../spec-directory-context/spec-directory-context.js';
import {
  SpecTargetContext,
  SpecTargetContextDiscoveryError,
  SpecTargetContextRootNotDirectoryError,
  SpecTargetContextRootNotFoundError,
  type SpecTargetContextTarget,
  SpecTargetContextTargetNotFoundError,
} from '../spec-target-context/spec-target-context.js';

const DEFAULT_SECTION_NAMES = [
  'Purpose',
];

export type SpecTreeRequest = {
  readonly rootDirectoryPath?: string;
  readonly sectionNames?: readonly string[];
  readonly targetDirectoryPath?: string;
  readonly targetPath?: string;
};

export type SpecTreeSectionLookup = Readonly<Record<string, readonly SpecSection[]>>;

export type SpecTreeSpecNode = {
  readonly type: 'spec';
  readonly name: string;
  readonly path: string;
  readonly title: string;
  readonly directoryLevel: boolean;
  readonly sections: SpecTreeSectionLookup;
};

export type SpecTreeDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  readonly spec: SpecTreeSpecNode | null;
  readonly specs: readonly SpecTreeSpecNode[];
  readonly children: readonly SpecTreeNode[];
};

export type SpecTreeNode = SpecTreeDirectoryNode | SpecTreeSpecNode;

export type SpecTreeResult = {
  readonly rootDirectoryPath: string;
  readonly targetDirectoryPath: string;
  readonly targetPath: string;
  readonly sectionNames: readonly string[];
  readonly root: SpecTreeDirectoryNode;
  readonly specs: readonly SpecTreeSpecNode[];
};

export type SpecTreePathFinder = (targetDirectoryPath: string) => Promise<readonly string[]>;

type SpecTreeFileSystemDependency = DirectoryCheckerDependency & FileExistenceDependency;

type SpecTreeSpecParserDependency = Pick<SpecParser, 'parseFile'>;

type SpecTreeParsedSpec = {
  readonly directoryPath: string;
  readonly document: SpecDocument;
  readonly name: string;
  readonly path: string;
};

type SpecTreeTarget = SpecTargetContextTarget;

type SpecTreeTargetContextDependency = Pick<
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

type MutableSpecTreeNode = MutableSpecTreeDirectoryNode | SpecTreeSpecNode;

type MutableSpecTreeDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  readonly specs: SpecTreeSpecNode[];
  readonly children: MutableSpecTreeNode[];
  readonly directoryChildren: Map<string, MutableSpecTreeDirectoryNode>;
};

export class SpecTreeTargetNotFoundError extends CliError {
  public constructor(path: string) {
    super(`Spec tree target not found: ${path}`);
    this.name = 'SpecTreeTargetNotFoundError';
  }
}

export class SpecTreeTargetNotDirectoryError extends CliError {
  public constructor(path: string) {
    super(`Spec tree target path is not a directory: ${path}`);
    this.name = 'SpecTreeTargetNotDirectoryError';
  }
}

export class SpecTreeAmbiguousTargetSpecError extends CliError {
  public constructor(path: string, specPaths: readonly string[]) {
    super(`Ambiguous target SpecDD specs for ${path}: ${specPaths.join(', ')}`);
    this.name = 'SpecTreeAmbiguousTargetSpecError';
  }
}

export class SpecTreeAmbiguousDirectorySpecError extends CliError {
  public constructor(directoryPath: string, specPaths: readonly string[]) {
    super(`Ambiguous directory-level SpecDD specs for ${directoryPath}: ${specPaths.join(', ')}`);
    this.name = 'SpecTreeAmbiguousDirectorySpecError';
  }
}

export class SpecTreeDiscoveryError extends CliError {
  public constructor(path: string, reason: string) {
    super(`Failed to discover SpecDD specs under ${path}: ${reason}`);
    this.name = 'SpecTreeDiscoveryError';
  }
}

export class SpecTreeParseError extends CliError {
  public constructor(path: string, reason: string) {
    super(`Failed to parse SpecDD spec ${path}: ${reason}`);
    this.name = 'SpecTreeParseError';
  }
}

export class SpecTree {
  private readonly specParser: SpecTreeSpecParserDependency;

  private readonly findSpecPaths: SpecTreePathFinder;

  private readonly targetContext: SpecTreeTargetContextDependency;

  public constructor(
    fileSystem: SpecTreeFileSystemDependency,
    specParser: SpecTreeSpecParserDependency,
    findSpecPaths: SpecTreePathFinder = SpecTree.findSpecPaths,
    targetContext: SpecTreeTargetContextDependency = new SpecTargetContext(fileSystem),
  ) {
    this.specParser = specParser;
    this.findSpecPaths = findSpecPaths;
    this.targetContext = targetContext;
  }

  public async build(request: SpecTreeRequest): Promise<SpecTreeResult> {
    const sectionNames = this.requestedSectionNames(request.sectionNames);
    const target = await this.resolveTarget(request.targetPath ?? request.targetDirectoryPath ?? '.');
    const rootDirectoryPath = await this.resolveRootDirectoryPath(request.rootDirectoryPath, target);
    const relativeSpecPaths = await this.discoverRelevantSpecPaths(rootDirectoryPath, target);
    const parsedSpecs = await this.parseSpecs(rootDirectoryPath, relativeSpecPaths);
    const directoryContextMatches = await this.directoryContextMatches(rootDirectoryPath, parsedSpecs);

    return {
      root: this.buildRootNode(rootDirectoryPath, parsedSpecs, sectionNames, directoryContextMatches),
      rootDirectoryPath,
      sectionNames,
      specs: this.buildFlatSpecList(parsedSpecs, sectionNames, directoryContextMatches),
      targetDirectoryPath: target.directoryPath,
      targetPath: target.path,
    };
  }

  private requestedSectionNames(sectionNames: readonly string[] | undefined): readonly string[] {
    if (undefined === sectionNames || 0 === sectionNames.length) {
      return DEFAULT_SECTION_NAMES;
    }

    return [
      ...sectionNames,
    ];
  }

  private async resolveTarget(targetPath: string): Promise<SpecTreeTarget> {
    try {
      return await this.targetContext.resolveTarget(targetPath);
    } catch (error) {
      this.raiseTargetContextError(error);
      throw error;
    }
  }

  private async resolveRootDirectoryPath(
    requestedRootDirectoryPath: string | undefined,
    target: SpecTreeTarget,
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
      throw new SpecTreeDiscoveryError(targetDirectoryPath, String(error));
    }
  }

  private async discoverRelevantSpecPaths(
    rootDirectoryPath: string,
    target: SpecTreeTarget,
  ): Promise<readonly string[]> {
    const allRelativeSpecPaths = await this.discoverSpecPaths(rootDirectoryPath);
    const contextResult = this.targetContext.contextSpecPaths(rootDirectoryPath, target.directoryPath, allRelativeSpecPaths);
    const targetSpecResult = this.targetContext.targetSpecPaths(rootDirectoryPath, target, allRelativeSpecPaths);
    const recursiveSpecPaths = 'directory' === target.kind
      ? this.targetContext.recursiveSpecPaths(rootDirectoryPath, target.path, allRelativeSpecPaths)
      : [];

    if (0 < contextResult.ambiguities.length) {
      const ambiguity = contextResult.ambiguities[0] as NonNullable<typeof contextResult.ambiguities[0]>;

      throw new SpecTreeAmbiguousDirectorySpecError(ambiguity.directoryPath, ambiguity.specPaths);
    }

    if (0 < targetSpecResult.ambiguities.length) {
      const ambiguity = targetSpecResult.ambiguities[0] as NonNullable<typeof targetSpecResult.ambiguities[0]>;

      throw new SpecTreeAmbiguousTargetSpecError(ambiguity.targetPath, ambiguity.specPaths);
    }

    return this.targetContext.uniqueSortedSpecPaths([
      ...contextResult.matches.map((match) => match.specPath),
      ...targetSpecResult.specPaths,
      ...recursiveSpecPaths,
    ]);
  }

  private async parseSpecs(
    targetDirectoryPath: string,
    relativeSpecPaths: readonly string[],
  ): Promise<readonly SpecTreeParsedSpec[]> {
    const parsedSpecs: SpecTreeParsedSpec[] = [];

    for (const relativePath of relativeSpecPaths) {
      const absolutePath = join(targetDirectoryPath, ...relativePath.split('/'));

      try {
        parsedSpecs.push({
          directoryPath: posix.dirname(relativePath),
          document: await this.specParser.parseFile({
            path: absolutePath,
          }),
          name: posix.basename(relativePath),
          path: relativePath,
        });
      } catch (error) {
        throw new SpecTreeParseError(relativePath, String(error));
      }
    }

    return parsedSpecs;
  }

  private buildRootNode(
    targetDirectoryPath: string,
    parsedSpecs: readonly SpecTreeParsedSpec[],
    sectionNames: readonly string[],
    directoryContextMatches: readonly SpecDirectoryContextMatch[],
  ): SpecTreeDirectoryNode {
    const root = this.createMutableDirectoryNode('.', basename(targetDirectoryPath));
    const parsedSpecByPath = new Map(parsedSpecs.map((parsedSpec) => [
      parsedSpec.path,
      parsedSpec,
    ]));
    const directoryLevelSpecPaths = new Set(directoryContextMatches.map((match) => match.specPath));

    for (const match of directoryContextMatches) {
      const parsedSpec = parsedSpecByPath.get(match.specPath) as SpecTreeParsedSpec;

      this.directoryNode(root, match.directoryPath).specs.push(this.specNode(parsedSpec, sectionNames, true));
    }

    for (const parsedSpec of parsedSpecs) {
      if (directoryLevelSpecPaths.has(parsedSpec.path)) {
        continue;
      }

      this.directoryNode(root, parsedSpec.directoryPath).children.push(this.specNode(parsedSpec, sectionNames, false));
    }

    return this.toDirectoryNode(root);
  }

  private buildFlatSpecList(
    parsedSpecs: readonly SpecTreeParsedSpec[],
    sectionNames: readonly string[],
    directoryContextMatches: readonly SpecDirectoryContextMatch[],
  ): readonly SpecTreeSpecNode[] {
    const directoryLevelSpecPaths = new Set(directoryContextMatches.map((match) => match.specPath));

    return parsedSpecs.map((parsedSpec) => this.specNode(
      parsedSpec,
      sectionNames,
      directoryLevelSpecPaths.has(parsedSpec.path),
    ));
  }

  private async directoryContextMatches(
    rootDirectoryPath: string,
    parsedSpecs: readonly SpecTreeParsedSpec[],
  ): Promise<readonly SpecDirectoryContextMatch[]> {
    let result;

    try {
      result = await this.targetContext.directoryContextMatches(rootDirectoryPath, parsedSpecs);
    } catch (error) {
      throw new SpecTreeDiscoveryError(rootDirectoryPath, (error as SpecTargetContextDiscoveryError).reason);
    }

    if (0 < result.ambiguities.length) {
      const ambiguity = result.ambiguities[0] as NonNullable<typeof result.ambiguities[0]>;

      throw new SpecTreeAmbiguousDirectorySpecError(ambiguity.directoryPath, ambiguity.specPaths);
    }

    return result.matches;
  }

  private directoryNode(
    root: MutableSpecTreeDirectoryNode,
    directoryPath: string,
  ): MutableSpecTreeDirectoryNode {
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

  private specNode(
    parsedSpec: SpecTreeParsedSpec,
    sectionNames: readonly string[],
    directoryLevel: boolean,
  ): SpecTreeSpecNode {
    return {
      directoryLevel,
      name: parsedSpec.name,
      path: parsedSpec.path,
      sections: this.requestedSections(parsedSpec.document, sectionNames),
      title: parsedSpec.document.title,
      type: 'spec',
    };
  }

  private requestedSections(
    document: SpecDocument,
    sectionNames: readonly string[],
  ): SpecTreeSectionLookup {
    const sections: Record<string, readonly SpecSection[]> = {};

    for (const sectionName of sectionNames) {
      sections[sectionName] = document.sectionLookup[sectionName] ?? [];
    }

    return sections;
  }

  private createMutableDirectoryNode(path: string, name: string): MutableSpecTreeDirectoryNode {
    return {
      children: [],
      directoryChildren: new Map(),
      name,
      path,
      specs: [],
      type: 'directory',
    };
  }

  private toDirectoryNode(node: MutableSpecTreeDirectoryNode): SpecTreeDirectoryNode {
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
      throw new SpecTreeTargetNotFoundError(error.path);
    }

    if (error instanceof SpecTargetContextRootNotDirectoryError) {
      throw new SpecTreeTargetNotDirectoryError(error.path);
    }

    if (error instanceof SpecTargetContextDiscoveryError) {
      throw new SpecTreeDiscoveryError(error.path, error.reason);
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
