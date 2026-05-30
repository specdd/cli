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
import type {
  SpecDocument,
  SpecParser,
  SpecSection,
} from '../spec-parser/spec-parser.js';

const DEFAULT_SECTION_NAMES = [
  'Purpose',
];

export type SpecTreeRequest = {
  readonly targetDirectoryPath: string;
  readonly sectionNames?: readonly string[];
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
  readonly children: readonly SpecTreeNode[];
};

export type SpecTreeNode = SpecTreeDirectoryNode | SpecTreeSpecNode;

export type SpecTreeResult = {
  readonly targetDirectoryPath: string;
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

type MutableSpecTreeDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  spec: SpecTreeSpecNode | null;
  readonly children: SpecTreeNode[];
  readonly directoryChildren: Map<string, MutableSpecTreeDirectoryNode>;
};

export class SpecTreeTargetNotFoundError extends CliError {
  public constructor(path: string) {
    super(`Spec tree target directory not found: ${path}`);
    this.name = 'SpecTreeTargetNotFoundError';
  }
}

export class SpecTreeTargetNotDirectoryError extends CliError {
  public constructor(path: string) {
    super(`Spec tree target path is not a directory: ${path}`);
    this.name = 'SpecTreeTargetNotDirectoryError';
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
  private readonly fileSystem: SpecTreeFileSystemDependency;

  private readonly specParser: SpecTreeSpecParserDependency;

  private readonly findSpecPaths: SpecTreePathFinder;

  public constructor(
    fileSystem: SpecTreeFileSystemDependency,
    specParser: SpecTreeSpecParserDependency,
    findSpecPaths: SpecTreePathFinder = SpecTree.findSpecPaths,
  ) {
    this.fileSystem = fileSystem;
    this.specParser = specParser;
    this.findSpecPaths = findSpecPaths;
  }

  public async build(request: SpecTreeRequest): Promise<SpecTreeResult> {
    const targetDirectoryPath = resolve(request.targetDirectoryPath);
    const sectionNames = this.requestedSectionNames(request.sectionNames);

    await this.validateTargetDirectory(targetDirectoryPath);

    const relativeSpecPaths = await this.discoverSpecPaths(targetDirectoryPath);
    const parsedSpecs = await this.parseSpecs(targetDirectoryPath, relativeSpecPaths);
    const directoryLevelSpecPaths = this.directoryLevelSpecPaths(targetDirectoryPath, parsedSpecs);

    return {
      root: this.buildRootNode(targetDirectoryPath, parsedSpecs, sectionNames, directoryLevelSpecPaths),
      sectionNames,
      specs: this.buildFlatSpecList(parsedSpecs, sectionNames, directoryLevelSpecPaths),
      targetDirectoryPath,
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

  private async validateTargetDirectory(targetDirectoryPath: string): Promise<void> {
    let targetExists: boolean;
    let targetIsDirectory: boolean;

    try {
      targetExists = await this.fileSystem.exists(targetDirectoryPath);
    } catch (error) {
      throw new SpecTreeDiscoveryError(targetDirectoryPath, String(error));
    }

    if (!targetExists) {
      throw new SpecTreeTargetNotFoundError(targetDirectoryPath);
    }

    try {
      targetIsDirectory = await this.fileSystem.isDirectory(targetDirectoryPath);
    } catch (error) {
      throw new SpecTreeDiscoveryError(targetDirectoryPath, String(error));
    }

    if (!targetIsDirectory) {
      throw new SpecTreeTargetNotDirectoryError(targetDirectoryPath);
    }
  }

  private async discoverSpecPaths(targetDirectoryPath: string): Promise<readonly string[]> {
    try {
      return [
        ...(await this.findSpecPaths(targetDirectoryPath)),
      ].map((path) => this.normalizeRelativePath(path)).sort();
    } catch (error) {
      throw new SpecTreeDiscoveryError(targetDirectoryPath, String(error));
    }
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
    directoryLevelSpecPaths: ReadonlySet<string>,
  ): SpecTreeDirectoryNode {
    const root = this.createMutableDirectoryNode('.', basename(targetDirectoryPath));

    for (const parsedSpec of parsedSpecs) {
      const directoryNode = this.directoryNode(root, parsedSpec.directoryPath);
      const isDirectoryLevel = directoryLevelSpecPaths.has(parsedSpec.path);
      const specNode = this.specNode(parsedSpec, sectionNames, isDirectoryLevel);

      if (isDirectoryLevel) {
        directoryNode.spec = specNode;

        continue;
      }

      directoryNode.children.push(specNode);
    }

    return this.toDirectoryNode(root);
  }

  private buildFlatSpecList(
    parsedSpecs: readonly SpecTreeParsedSpec[],
    sectionNames: readonly string[],
    directoryLevelSpecPaths: ReadonlySet<string>,
  ): readonly SpecTreeSpecNode[] {
    return parsedSpecs.map((parsedSpec) => this.specNode(
      parsedSpec,
      sectionNames,
      directoryLevelSpecPaths.has(parsedSpec.path),
    ));
  }

  private directoryLevelSpecPaths(
    targetDirectoryPath: string,
    parsedSpecs: readonly SpecTreeParsedSpec[],
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
    parsedSpecs: readonly SpecTreeParsedSpec[],
  ): ReadonlyMap<string, readonly SpecTreeParsedSpec[]> {
    const specsByDirectoryPath = new Map<string, SpecTreeParsedSpec[]>();

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
    specs: readonly SpecTreeParsedSpec[],
  ): SpecTreeParsedSpec | null {
    const exactMatch = specs.find((spec) => this.specBasename(spec) === directoryBasename);

    if (undefined !== exactMatch) {
      return exactMatch;
    }

    const lowercaseMatches = specs.filter((spec) => this.specBasename(spec).toLowerCase() === directoryBasename.toLowerCase());

    if (1 < lowercaseMatches.length) {
      throw new SpecTreeAmbiguousDirectorySpecError(directoryPath, lowercaseMatches.map((spec) => spec.path));
    }

    return lowercaseMatches[0] ?? null;
  }

  private specBasename(spec: SpecTreeParsedSpec): string {
    return spec.name.slice(0, -'.sdd'.length);
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
      spec: null,
      type: 'directory',
    };
  }

  private toDirectoryNode(node: MutableSpecTreeDirectoryNode): SpecTreeDirectoryNode {
    return {
      children: node.children.sort((left, right) => left.path.localeCompare(right.path)).map((child) => {
        if ('directory' === child.type) {
          return this.toDirectoryNode(child as MutableSpecTreeDirectoryNode);
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
