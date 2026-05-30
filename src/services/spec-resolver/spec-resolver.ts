import fg from 'fast-glob';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
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
  SpecSectionName,
} from '../spec-parser/spec-parser.js';

const DEFAULT_SECTION_NAMES = [
  'Purpose',
];

const DEFAULT_LINK_DEPTH = 2;

const LINK_SECTION_NAMES = new Set<SpecSectionName>([
  'Can modify',
  'Can read',
  'Depends on',
  'References',
  'Structure',
  'Owns',
]);

export type SpecResolveLinkDepth = number | 'all';

export type SpecResolveRequest = {
  readonly rootDirectoryPath: string;
  readonly targetPath: string;
  readonly sectionNames?: readonly string[];
  readonly linkDepth?: SpecResolveLinkDepth;
};

export type SpecResolveReason =
  | {
    readonly kind: 'target';
  }
  | {
    readonly directoryPath: string;
    readonly kind: 'parent';
  }
  | {
    readonly depth: number;
    readonly fromPath: string;
    readonly kind: 'link';
    readonly sectionName: SpecSectionName;
    readonly target: string;
  };

export type SpecResolveSectionLookup = Readonly<Record<string, readonly SpecSection[]>>;

export type SpecResolveSpecNode = {
  readonly type: 'spec';
  readonly name: string;
  readonly path: string;
  readonly title: string;
  readonly directoryLevel: boolean;
  readonly reasons: readonly SpecResolveReason[];
  readonly sections: SpecResolveSectionLookup;
};

export type SpecResolveDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  readonly spec: SpecResolveSpecNode | null;
  readonly children: readonly SpecResolveNode[];
};

export type SpecResolveNode = SpecResolveDirectoryNode | SpecResolveSpecNode;

export type SpecResolveResult = {
  readonly rootDirectoryPath: string;
  readonly targetPath: string;
  readonly linkDepth: SpecResolveLinkDepth;
  readonly sectionNames: readonly string[];
  readonly root: SpecResolveDirectoryNode;
  readonly specs: readonly SpecResolveSpecNode[];
};

export type SpecResolvePathFinder = (cwd: string, pattern: string) => Promise<readonly string[]>;

type SpecResolveFileSystemDependency = DirectoryCheckerDependency & FileExistenceDependency;

type SpecResolveSpecParserDependency = Pick<SpecParser, 'parseFile'>;

type MutableResolvedSpec = {
  readonly directoryPath: string;
  readonly document: SpecDocument;
  readonly name: string;
  readonly path: string;
  readonly reasons: SpecResolveReason[];
};

type MutableSpecResolveDirectoryNode = {
  readonly type: 'directory';
  readonly name: string;
  readonly path: string;
  spec: SpecResolveSpecNode | null;
  readonly children: SpecResolveNode[];
  readonly directoryChildren: Map<string, MutableSpecResolveDirectoryNode>;
};

type ExplicitPathLink = {
  readonly sectionName: SpecSectionName;
  readonly target: string;
};

type QueuedSpecExpansion = {
  readonly depth: number;
  readonly path: string;
};

export class SpecResolveRootNotFoundError extends CliError {
  public constructor(path: string) {
    super(`Spec resolve root directory not found: ${path}`);
    this.name = 'SpecResolveRootNotFoundError';
  }
}

export class SpecResolveRootNotDirectoryError extends CliError {
  public constructor(path: string) {
    super(`Spec resolve root path is not a directory: ${path}`);
    this.name = 'SpecResolveRootNotDirectoryError';
  }
}

export class SpecResolveTargetNotFoundError extends CliError {
  public constructor(path: string) {
    super(`Spec resolve target not found: ${path}`);
    this.name = 'SpecResolveTargetNotFoundError';
  }
}

export class SpecResolveTargetOutsideRootError extends CliError {
  public constructor(targetPath: string, rootDirectoryPath: string) {
    super(`Spec resolve target is outside root: ${targetPath} is not under ${rootDirectoryPath}`);
    this.name = 'SpecResolveTargetOutsideRootError';
  }
}

export class SpecResolveUnsupportedTargetError extends CliError {
  public constructor(path: string) {
    super(`Spec resolve target must be a directory or .sdd file: ${path}`);
    this.name = 'SpecResolveUnsupportedTargetError';
  }
}

export class SpecResolveAmbiguousDirectorySpecError extends CliError {
  public constructor(directoryPath: string, specPaths: readonly string[]) {
    super(`Ambiguous directory-level SpecDD specs for ${directoryPath}: ${specPaths.join(', ')}`);
    this.name = 'SpecResolveAmbiguousDirectorySpecError';
  }
}

export class SpecResolveDiscoveryError extends CliError {
  public constructor(path: string, reason: string) {
    super(`Failed to discover SpecDD specs for ${path}: ${reason}`);
    this.name = 'SpecResolveDiscoveryError';
  }
}

export class SpecResolveParseError extends CliError {
  public constructor(path: string, reason: string) {
    super(`Failed to parse SpecDD spec ${path}: ${reason}`);
    this.name = 'SpecResolveParseError';
  }
}

export class SpecResolver {
  private readonly fileSystem: SpecResolveFileSystemDependency;

  private readonly specParser: SpecResolveSpecParserDependency;

  private readonly findSpecPaths: SpecResolvePathFinder;

  public constructor(
    fileSystem: SpecResolveFileSystemDependency,
    specParser: SpecResolveSpecParserDependency,
    findSpecPaths: SpecResolvePathFinder = SpecResolver.findSpecPaths,
  ) {
    this.fileSystem = fileSystem;
    this.specParser = specParser;
    this.findSpecPaths = findSpecPaths;
  }

  public async resolve(request: SpecResolveRequest): Promise<SpecResolveResult> {
    const rootDirectoryPath = resolve(request.rootDirectoryPath);
    const targetPath = resolve(request.targetPath);
    const sectionNames = this.requestedSectionNames(request.sectionNames);
    const linkDepth = request.linkDepth ?? DEFAULT_LINK_DEPTH;
    const targetIsDirectory = await this.validateRootAndTarget(rootDirectoryPath, targetPath);
    const resolvedSpecs = new Map<string, MutableResolvedSpec>();
    const expansionQueue = await this.resolveVerticalContext(
      rootDirectoryPath,
      targetPath,
      targetIsDirectory,
      resolvedSpecs,
    );

    await this.expandSoftLinks(rootDirectoryPath, resolvedSpecs, expansionQueue, linkDepth);

    const parsedSpecs = [
      ...resolvedSpecs.values(),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const directoryLevelSpecPaths = this.directoryLevelSpecPaths(rootDirectoryPath, parsedSpecs);

    return {
      linkDepth,
      root: this.buildRootNode(rootDirectoryPath, parsedSpecs, sectionNames, directoryLevelSpecPaths),
      rootDirectoryPath,
      sectionNames,
      specs: this.buildFlatSpecList(parsedSpecs, sectionNames, directoryLevelSpecPaths),
      targetPath,
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

  private async validateRootAndTarget(rootDirectoryPath: string, targetPath: string): Promise<boolean> {
    if (!await this.exists(rootDirectoryPath)) {
      throw new SpecResolveRootNotFoundError(rootDirectoryPath);
    }

    if (!await this.isDirectory(rootDirectoryPath)) {
      throw new SpecResolveRootNotDirectoryError(rootDirectoryPath);
    }

    if (!await this.exists(targetPath)) {
      throw new SpecResolveTargetNotFoundError(targetPath);
    }

    if (!this.isInsideOrSame(rootDirectoryPath, targetPath)) {
      throw new SpecResolveTargetOutsideRootError(targetPath, rootDirectoryPath);
    }

    const targetIsDirectory = await this.isDirectory(targetPath);

    if (!targetIsDirectory && '.sdd' !== extname(targetPath)) {
      throw new SpecResolveUnsupportedTargetError(targetPath);
    }

    return targetIsDirectory;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.fileSystem.exists(path);
    } catch (error) {
      throw new SpecResolveDiscoveryError(path, String(error));
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return await this.fileSystem.isDirectory(path);
    } catch (error) {
      throw new SpecResolveDiscoveryError(path, String(error));
    }
  }

  private async resolveVerticalContext(
    rootDirectoryPath: string,
    targetPath: string,
    targetIsDirectory: boolean,
    resolvedSpecs: Map<string, MutableResolvedSpec>,
  ): Promise<readonly QueuedSpecExpansion[]> {
    const targetDirectoryPath = targetIsDirectory ? targetPath : dirname(targetPath);
    const targetSpecPath = targetIsDirectory ? null : targetPath;
    const queuedSpecExpansions = new Map<string, number>();

    for (const directoryPath of this.directoryChain(rootDirectoryPath, targetDirectoryPath)) {
      const directoryLevelSpecPath = await this.directoryLevelSpecPath(rootDirectoryPath, directoryPath);

      if (null === directoryLevelSpecPath) {
        continue;
      }

      const reason = this.verticalReason(rootDirectoryPath, directoryPath, targetDirectoryPath, targetIsDirectory, targetSpecPath, directoryLevelSpecPath);
      const relativeSpecPath = await this.addResolvedSpec(rootDirectoryPath, resolvedSpecs, directoryLevelSpecPath, reason);

      this.queueSpecExpansion(
        queuedSpecExpansions,
        relativeSpecPath,
        this.verticalExpansionDepth(directoryPath, targetDirectoryPath, reason),
      );
    }

    if (null !== targetSpecPath) {
      const targetSpecRelativePath = await this.addResolvedSpec(rootDirectoryPath, resolvedSpecs, targetSpecPath, {
        kind: 'target',
      });

      this.queueSpecExpansion(queuedSpecExpansions, targetSpecRelativePath, 0);
    }

    return this.queuedSpecExpansions(queuedSpecExpansions);
  }

  private verticalExpansionDepth(
    directoryPath: string,
    targetDirectoryPath: string,
    reason: SpecResolveReason,
  ): number {
    if ('target' === reason.kind) {
      return 0;
    }

    return Math.max(1, this.directoryDistance(directoryPath, targetDirectoryPath));
  }

  private directoryDistance(ancestorDirectoryPath: string, descendantDirectoryPath: string): number {
    const relativePath = relative(ancestorDirectoryPath, descendantDirectoryPath);

    if ('' === relativePath) {
      return 0;
    }

    return relativePath.split(/[\\/]+/u).filter((segment) => '' !== segment && '.' !== segment).length;
  }

  private queueSpecExpansion(
    queuedSpecExpansions: Map<string, number>,
    path: string,
    depth: number,
  ): void {
    const existingDepth = queuedSpecExpansions.get(path);

    if (undefined !== existingDepth && existingDepth <= depth) {
      return;
    }

    queuedSpecExpansions.set(path, depth);
  }

  private queuedSpecExpansions(queuedSpecExpansions: ReadonlyMap<string, number>): readonly QueuedSpecExpansion[] {
    return [
      ...queuedSpecExpansions.entries(),
    ].map(([path, depth]) => ({
      depth,
      path,
    })).sort((left, right) => {
      const depthDifference = left.depth - right.depth;

      if (0 !== depthDifference) {
        return depthDifference;
      }

      return left.path.localeCompare(right.path);
    });
  }

  private verticalReason(
    rootDirectoryPath: string,
    directoryPath: string,
    targetDirectoryPath: string,
    targetIsDirectory: boolean,
    targetSpecPath: string | null,
    directoryLevelSpecPath: string,
  ): SpecResolveReason {
    if (targetIsDirectory && directoryPath === targetDirectoryPath) {
      return {
        kind: 'target',
      };
    }

    if (null !== targetSpecPath && targetSpecPath === directoryLevelSpecPath) {
      return {
        kind: 'target',
      };
    }

    return {
      directoryPath: this.relativeDirectoryPath(rootDirectoryPath, directoryPath),
      kind: 'parent',
    };
  }

  private directoryChain(rootDirectoryPath: string, targetDirectoryPath: string): readonly string[] {
    const directories = [];
    let currentDirectoryPath = targetDirectoryPath;

    while (true) {
      directories.push(currentDirectoryPath);

      if (currentDirectoryPath === rootDirectoryPath) {
        break;
      }

      currentDirectoryPath = dirname(currentDirectoryPath);
    }

    return directories.reverse();
  }

  private async directoryLevelSpecPath(rootDirectoryPath: string, directoryPath: string): Promise<string | null> {
    const specPaths = await this.discoverSpecPaths(directoryPath, '*.sdd');
    const directoryBasename = basename(directoryPath);
    const exactMatch = specPaths.find((specPath) => this.specBasename(specPath) === directoryBasename);

    if (undefined !== exactMatch) {
      return exactMatch;
    }

    const lowercaseMatches = specPaths.filter((specPath) => this.specBasename(specPath).toLowerCase() === directoryBasename.toLowerCase());

    if (1 < lowercaseMatches.length) {
      throw new SpecResolveAmbiguousDirectorySpecError(
        this.relativeDirectoryPath(rootDirectoryPath, directoryPath),
        lowercaseMatches.map((specPath) => this.relativeSpecPath(rootDirectoryPath, specPath)),
      );
    }

    if (undefined !== lowercaseMatches[0]) {
      return lowercaseMatches[0];
    }

    if (directoryPath === rootDirectoryPath) {
      return specPaths.find((specPath) => 'app' === this.specBasename(specPath)) ?? null;
    }

    return null;
  }

  private async addResolvedSpec(
    rootDirectoryPath: string,
    resolvedSpecs: Map<string, MutableResolvedSpec>,
    absoluteSpecPath: string,
    reason: SpecResolveReason,
  ): Promise<string> {
    const relativeSpecPath = this.relativeSpecPath(rootDirectoryPath, absoluteSpecPath);
    const existingSpec = resolvedSpecs.get(relativeSpecPath);

    if (undefined !== existingSpec) {
      this.addReason(existingSpec, reason);

      return relativeSpecPath;
    }

    let document: SpecDocument;

    try {
      document = await this.specParser.parseFile({
        path: absoluteSpecPath,
      });
    } catch (error) {
      throw new SpecResolveParseError(relativeSpecPath, String(error));
    }

    const resolvedSpec: MutableResolvedSpec = {
      directoryPath: posix.dirname(relativeSpecPath),
      document,
      name: posix.basename(relativeSpecPath),
      path: relativeSpecPath,
      reasons: [],
    };

    this.addReason(resolvedSpec, reason);
    resolvedSpecs.set(relativeSpecPath, resolvedSpec);

    return relativeSpecPath;
  }

  private addReason(spec: MutableResolvedSpec, reason: SpecResolveReason): void {
    const reasonKey = JSON.stringify(reason);

    if (spec.reasons.some((existingReason) => JSON.stringify(existingReason) === reasonKey)) {
      return;
    }

    spec.reasons.push(reason);
  }

  private async expandSoftLinks(
    rootDirectoryPath: string,
    resolvedSpecs: Map<string, MutableResolvedSpec>,
    queuedSpecExpansions: readonly QueuedSpecExpansion[],
    linkDepth: SpecResolveLinkDepth,
  ): Promise<void> {
    const queue: QueuedSpecExpansion[] = [
      ...queuedSpecExpansions,
    ];
    const expandedDepthByPath = new Map<string, number>();

    while (0 < queue.length) {
      const queuedSpec = queue.shift() as QueuedSpecExpansion;

      if (!this.canExpandAtDepth(queuedSpec.depth, linkDepth)) {
        continue;
      }

      const previousExpandedDepth = expandedDepthByPath.get(queuedSpec.path);

      if (undefined !== previousExpandedDepth && previousExpandedDepth <= queuedSpec.depth) {
        continue;
      }

      expandedDepthByPath.set(queuedSpec.path, queuedSpec.depth);

      const resolvedSpec = resolvedSpecs.get(queuedSpec.path) as MutableResolvedSpec;

      for (const link of this.explicitPathLinks(resolvedSpec.document)) {
        const linkedSpecPaths = await this.resolveLinkedSpecPaths(rootDirectoryPath, resolvedSpec.path, link.target);

        for (const linkedSpecPath of linkedSpecPaths) {
          const linkedRelativePath = await this.addResolvedSpec(rootDirectoryPath, resolvedSpecs, linkedSpecPath, {
            depth: queuedSpec.depth + 1,
            fromPath: resolvedSpec.path,
            kind: 'link',
            sectionName: link.sectionName,
            target: link.target,
          });

          queue.push({
            depth: queuedSpec.depth + 1,
            path: linkedRelativePath,
          });
        }
      }
    }
  }

  private canExpandAtDepth(currentDepth: number, linkDepth: SpecResolveLinkDepth): boolean {
    if ('all' === linkDepth) {
      return true;
    }

    return currentDepth < linkDepth;
  }

  private explicitPathLinks(document: SpecDocument): readonly ExplicitPathLink[] {
    const links: ExplicitPathLink[] = [];
    const seenLinks = new Set<string>();

    for (const section of document.sections) {
      if (!LINK_SECTION_NAMES.has(section.name)) {
        continue;
      }

      for (const entry of section.entries) {
        for (const target of this.explicitPathTargets(entry.text)) {
          const linkKey = `${section.name}\0${target}`;

          if (seenLinks.has(linkKey)) {
            continue;
          }

          seenLinks.add(linkKey);
          links.push({
            sectionName: section.name,
            target,
          });
        }
      }
    }

    return links;
  }

  private explicitPathTargets(text: string): readonly string[] {
    const targets = [];
    const pattern = /(^|[\s([{<"'])((?:\.{1,2}\/|\/)[^\s`"'<>]*)/gu;
    let match: RegExpExecArray | null = pattern.exec(text);

    while (null !== match) {
      const target = this.cleanPathCandidate(match[2] as string);

      if (this.isExplicitPath(target)) {
        targets.push(target);
      }

      match = pattern.exec(text);
    }

    return targets;
  }

  private cleanPathCandidate(candidate: string): string {
    let cleanedCandidate = candidate.replace(/^`+|`+$/gu, '');

    while (/[),.;:]$/u.test(cleanedCandidate)) {
      cleanedCandidate = cleanedCandidate.slice(0, -1);
    }

    return cleanedCandidate;
  }

  private isExplicitPath(target: string): boolean {
    return target.startsWith('./') || target.startsWith('../') || target.startsWith('/');
  }

  private async resolveLinkedSpecPaths(
    rootDirectoryPath: string,
    sourceSpecPath: string,
    target: string,
  ): Promise<readonly string[]> {
    const sourceDirectoryPath = join(rootDirectoryPath, ...posix.dirname(sourceSpecPath).split('/').filter((segment) => '.' !== segment));
    const searchRootPath = target.startsWith('/') ? rootDirectoryPath : sourceDirectoryPath;
    const searchTarget = target.startsWith('/') ? target.slice(1) : target;

    if (this.hasGlob(searchTarget)) {
      return this.filterSpecPathsUnderRoot(rootDirectoryPath, await this.discoverSpecPaths(searchRootPath, searchTarget));
    }

    const absoluteTargetPath = resolve(searchRootPath, searchTarget);

    if (!this.isInsideOrSame(rootDirectoryPath, absoluteTargetPath) || !await this.exists(absoluteTargetPath)) {
      return [];
    }

    if (await this.isDirectory(absoluteTargetPath)) {
      return this.filterSpecPathsUnderRoot(rootDirectoryPath, await this.discoverSpecPaths(absoluteTargetPath, '**/*.sdd'));
    }

    if ('.sdd' !== extname(absoluteTargetPath)) {
      return [];
    }

    return [
      absoluteTargetPath,
    ];
  }

  private hasGlob(pattern: string): boolean {
    return /[*?[\]{}]/u.test(pattern);
  }

  private async discoverSpecPaths(cwd: string, pattern: string): Promise<readonly string[]> {
    try {
      return [
        ...(await this.findSpecPaths(cwd, pattern)),
      ].map((path) => isAbsolute(path) ? resolve(path) : resolve(cwd, path)).filter((path) => '.sdd' === extname(path)).sort();
    } catch (error) {
      throw new SpecResolveDiscoveryError(cwd, String(error));
    }
  }

  private filterSpecPathsUnderRoot(rootDirectoryPath: string, specPaths: readonly string[]): readonly string[] {
    return specPaths.filter((specPath) => this.isInsideOrSame(rootDirectoryPath, specPath));
  }

  private directoryLevelSpecPaths(
    rootDirectoryPath: string,
    parsedSpecs: readonly MutableResolvedSpec[],
  ): Set<string> {
    const specsByDirectoryPath = this.groupSpecsByDirectoryPath(parsedSpecs);
    const directoryLevelSpecPaths = new Set<string>();

    for (const [directoryPath, specs] of specsByDirectoryPath.entries()) {
      const directoryBasename = this.directoryBasename(rootDirectoryPath, directoryPath);
      const directoryLevelSpec = this.directoryLevelSpec(directoryPath, directoryBasename, specs);

      if (null !== directoryLevelSpec) {
        directoryLevelSpecPaths.add(directoryLevelSpec.path);
      }
    }

    return directoryLevelSpecPaths;
  }

  private groupSpecsByDirectoryPath(
    parsedSpecs: readonly MutableResolvedSpec[],
  ): ReadonlyMap<string, readonly MutableResolvedSpec[]> {
    const specsByDirectoryPath = new Map<string, MutableResolvedSpec[]>();

    for (const parsedSpec of parsedSpecs) {
      specsByDirectoryPath.set(parsedSpec.directoryPath, [
        ...(specsByDirectoryPath.get(parsedSpec.directoryPath) ?? []),
        parsedSpec,
      ]);
    }

    return specsByDirectoryPath;
  }

  private directoryBasename(rootDirectoryPath: string, directoryPath: string): string {
    if ('.' === directoryPath) {
      return basename(rootDirectoryPath);
    }

    return posix.basename(directoryPath);
  }

  private directoryLevelSpec(
    directoryPath: string,
    directoryBasename: string,
    specs: readonly MutableResolvedSpec[],
  ): MutableResolvedSpec | null {
    const exactMatch = specs.find((spec) => this.resolvedSpecBasename(spec) === directoryBasename);

    if (undefined !== exactMatch) {
      return exactMatch;
    }

    const lowercaseMatches = specs.filter((spec) => this.resolvedSpecBasename(spec).toLowerCase() === directoryBasename.toLowerCase());

    if (1 < lowercaseMatches.length) {
      throw new SpecResolveAmbiguousDirectorySpecError(directoryPath, lowercaseMatches.map((spec) => spec.path));
    }

    return lowercaseMatches[0] ?? null;
  }

  private resolvedSpecBasename(spec: MutableResolvedSpec): string {
    return spec.name.slice(0, -'.sdd'.length);
  }

  private buildRootNode(
    rootDirectoryPath: string,
    parsedSpecs: readonly MutableResolvedSpec[],
    sectionNames: readonly string[],
    directoryLevelSpecPaths: ReadonlySet<string>,
  ): SpecResolveDirectoryNode {
    const root = this.createMutableDirectoryNode('.', basename(rootDirectoryPath));

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
    parsedSpecs: readonly MutableResolvedSpec[],
    sectionNames: readonly string[],
    directoryLevelSpecPaths: ReadonlySet<string>,
  ): readonly SpecResolveSpecNode[] {
    return parsedSpecs.map((parsedSpec) => this.specNode(
      parsedSpec,
      sectionNames,
      directoryLevelSpecPaths.has(parsedSpec.path),
    ));
  }

  private directoryNode(
    root: MutableSpecResolveDirectoryNode,
    directoryPath: string,
  ): MutableSpecResolveDirectoryNode {
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
    parsedSpec: MutableResolvedSpec,
    sectionNames: readonly string[],
    directoryLevel: boolean,
  ): SpecResolveSpecNode {
    return {
      directoryLevel,
      name: parsedSpec.name,
      path: parsedSpec.path,
      reasons: [
        ...parsedSpec.reasons,
      ],
      sections: this.requestedSections(parsedSpec.document, sectionNames),
      title: parsedSpec.document.title,
      type: 'spec',
    };
  }

  private requestedSections(
    document: SpecDocument,
    sectionNames: readonly string[],
  ): SpecResolveSectionLookup {
    const sections: Record<string, readonly SpecSection[]> = {};

    for (const sectionName of sectionNames) {
      sections[sectionName] = document.sectionLookup[sectionName] ?? [];
    }

    return sections;
  }

  private createMutableDirectoryNode(path: string, name: string): MutableSpecResolveDirectoryNode {
    return {
      children: [],
      directoryChildren: new Map(),
      name,
      path,
      spec: null,
      type: 'directory',
    };
  }

  private toDirectoryNode(node: MutableSpecResolveDirectoryNode): SpecResolveDirectoryNode {
    return {
      children: node.children.sort((left, right) => left.path.localeCompare(right.path)).map((child) => {
        if ('directory' === child.type) {
          return this.toDirectoryNode(child as MutableSpecResolveDirectoryNode);
        }

        return child;
      }),
      name: node.name,
      path: node.path,
      spec: node.spec,
      type: 'directory',
    };
  }

  private specBasename(specPath: string): string {
    return basename(specPath).slice(0, -'.sdd'.length);
  }

  private relativeDirectoryPath(rootDirectoryPath: string, directoryPath: string): string {
    const relativePath = this.normalizeRelativePath(relative(rootDirectoryPath, directoryPath));

    if ('' === relativePath) {
      return '.';
    }

    return relativePath;
  }

  private relativeSpecPath(rootDirectoryPath: string, specPath: string): string {
    return this.normalizeRelativePath(relative(rootDirectoryPath, specPath));
  }

  private normalizeRelativePath(path: string): string {
    return path.replaceAll('\\', '/');
  }

  private isInsideOrSame(rootDirectoryPath: string, targetPath: string): boolean {
    const relativePath = relative(rootDirectoryPath, targetPath);

    return '' === relativePath || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
  }

  private static async findSpecPaths(cwd: string, pattern: string): Promise<readonly string[]> {
    return fg(pattern, {
      absolute: true,
      cwd,
      dot: true,
      onlyFiles: true,
      unique: true,
    });
  }
}
