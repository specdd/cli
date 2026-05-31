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
import {
  SpecDirectoryContext,
  type SpecDirectoryContextAmbiguity,
  type SpecDirectoryContextMatch,
} from '../spec-directory-context/spec-directory-context.js';

export type SpecTargetContextTargetKind = 'directory' | 'file' | 'spec';

export type SpecTargetContextTarget = {
  readonly directoryPath: string;
  readonly kind: SpecTargetContextTargetKind;
  readonly path: string;
};

export type SpecTargetContextRootAndTarget = {
  readonly rootDirectoryPath: string;
  readonly target: SpecTargetContextTarget;
};

export type SpecTargetContextPathLike = {
  readonly directoryPath: string;
  readonly path: string;
};

export type SpecTargetContextTargetSpecAmbiguity = {
  readonly specPaths: readonly string[];
  readonly targetPath: string;
};

export type SpecTargetContextTargetSpecResult = {
  readonly ambiguities: readonly SpecTargetContextTargetSpecAmbiguity[];
  readonly specPaths: readonly string[];
};

export type SpecTargetContextMatchResult = {
  readonly ambiguities: readonly SpecDirectoryContextAmbiguity[];
  readonly matches: readonly SpecDirectoryContextMatch[];
};

type SpecTargetContextFileSystemDependency = DirectoryCheckerDependency & FileExistenceDependency;

export class SpecTargetContextTargetNotFoundError extends CliError {
  public constructor(public readonly path: string) {
    super(`Spec target not found: ${path}`);
    this.name = 'SpecTargetContextTargetNotFoundError';
  }
}

export class SpecTargetContextRootNotFoundError extends CliError {
  public constructor(public readonly path: string) {
    super(`Spec root directory not found: ${path}`);
    this.name = 'SpecTargetContextRootNotFoundError';
  }
}

export class SpecTargetContextRootNotDirectoryError extends CliError {
  public constructor(public readonly path: string) {
    super(`Spec root path is not a directory: ${path}`);
    this.name = 'SpecTargetContextRootNotDirectoryError';
  }
}

export class SpecTargetContextTargetOutsideRootError extends CliError {
  public constructor(
    public readonly targetPath: string,
    public readonly rootDirectoryPath: string,
  ) {
    super(`Spec target is outside root: ${targetPath} is not under ${rootDirectoryPath}`);
    this.name = 'SpecTargetContextTargetOutsideRootError';
  }
}

export class SpecTargetContextDiscoveryError extends CliError {
  public constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Failed to discover SpecDD target context for ${path}: ${reason}`);
    this.name = 'SpecTargetContextDiscoveryError';
  }
}

export class SpecTargetContext {
  private readonly fileSystem: SpecTargetContextFileSystemDependency;

  private readonly specDirectoryContext = new SpecDirectoryContext();

  public constructor(fileSystem: SpecTargetContextFileSystemDependency) {
    this.fileSystem = fileSystem;
  }

  public async resolveTarget(targetPath: string): Promise<SpecTargetContextTarget> {
    const absoluteTargetPath = resolve(targetPath);

    if (!await this.exists(absoluteTargetPath)) {
      throw new SpecTargetContextTargetNotFoundError(absoluteTargetPath);
    }

    if (await this.isDirectory(absoluteTargetPath)) {
      return {
        directoryPath: absoluteTargetPath,
        kind: 'directory',
        path: absoluteTargetPath,
      };
    }

    return {
      directoryPath: dirname(absoluteTargetPath),
      kind: '.sdd' === extname(absoluteTargetPath) ? 'spec' : 'file',
      path: absoluteTargetPath,
    };
  }

  public async resolvePreferredRootDirectoryPath(
    requestedRootDirectoryPath: string | undefined,
    target: SpecTargetContextTarget,
  ): Promise<string> {
    const fallbackRootDirectoryPath = 'directory' === target.kind ? target.path : target.directoryPath;

    if (undefined === requestedRootDirectoryPath) {
      return fallbackRootDirectoryPath;
    }

    const rootDirectoryPath = resolve(requestedRootDirectoryPath);

    if (!this.isInsideOrSame(rootDirectoryPath, target.path)) {
      return fallbackRootDirectoryPath;
    }

    await this.validateRootDirectory(rootDirectoryPath);

    return rootDirectoryPath;
  }

  public async resolveRequiredRootAndTarget(
    rootDirectoryPath: string,
    targetPath: string,
  ): Promise<SpecTargetContextRootAndTarget> {
    const absoluteRootDirectoryPath = resolve(rootDirectoryPath);

    await this.validateRootDirectory(absoluteRootDirectoryPath);

    const target = await this.resolveTarget(targetPath);

    if (!this.isInsideOrSame(absoluteRootDirectoryPath, target.path)) {
      throw new SpecTargetContextTargetOutsideRootError(target.path, absoluteRootDirectoryPath);
    }

    return {
      rootDirectoryPath: absoluteRootDirectoryPath,
      target,
    };
  }

  public contextSpecPaths(
    rootDirectoryPath: string,
    targetDirectoryPath: string,
    allRelativeSpecPaths: readonly string[],
  ): SpecTargetContextMatchResult {
    return this.specDirectoryContext.match({
      directoryPaths: this.relativeDirectoryChain(rootDirectoryPath, targetDirectoryPath),
      rootDirectoryName: basename(rootDirectoryPath),
      specPaths: allRelativeSpecPaths,
    });
  }

  public directorySpecMatches(
    rootDirectoryPath: string,
    directoryPath: string,
    relativeSpecPaths: readonly string[],
  ): SpecTargetContextMatchResult {
    return this.specDirectoryContext.match({
      directoryPaths: [
        this.relativeDirectoryPath(rootDirectoryPath, directoryPath),
      ],
      rootDirectoryName: basename(rootDirectoryPath),
      specPaths: relativeSpecPaths,
    });
  }

  public targetSpecPaths(
    rootDirectoryPath: string,
    target: SpecTargetContextTarget,
    allRelativeSpecPaths: readonly string[],
  ): SpecTargetContextTargetSpecResult {
    if ('spec' === target.kind) {
      return {
        ambiguities: [],
        specPaths: [
          this.relativeSpecPath(rootDirectoryPath, target.path),
        ],
      };
    }

    if ('file' === target.kind) {
      return this.fileTargetSpecPaths(rootDirectoryPath, target.path, allRelativeSpecPaths);
    }

    return {
      ambiguities: [],
      specPaths: [],
    };
  }

  public recursiveSpecPaths(
    rootDirectoryPath: string,
    targetDirectoryPath: string,
    allRelativeSpecPaths: readonly string[],
  ): readonly string[] {
    return allRelativeSpecPaths.filter((relativeSpecPath) => (
      this.isInsideOrSame(targetDirectoryPath, this.absoluteSpecPath(rootDirectoryPath, relativeSpecPath))
    ));
  }

  public async directoryContextMatches(
    rootDirectoryPath: string,
    specs: readonly SpecTargetContextPathLike[],
  ): Promise<SpecTargetContextMatchResult> {
    return this.specDirectoryContext.match({
      directoryPaths: await this.knownDirectoryPaths(rootDirectoryPath, specs),
      rootDirectoryName: basename(rootDirectoryPath),
      specPaths: specs.map((spec) => spec.path),
    });
  }

  public relativeDirectoryPath(rootDirectoryPath: string, directoryPath: string): string {
    const relativePath = this.relativePath(rootDirectoryPath, directoryPath);

    if ('' === relativePath) {
      return '.';
    }

    return relativePath;
  }

  public relativeSpecPath(rootDirectoryPath: string, specPath: string): string {
    return this.relativePath(rootDirectoryPath, specPath);
  }

  public relativePath(rootDirectoryPath: string, path: string): string {
    return this.normalizeRelativePath(relative(rootDirectoryPath, path));
  }

  public absoluteDirectoryPath(rootDirectoryPath: string, directoryPath: string): string {
    return join(rootDirectoryPath, ...directoryPath.split('/'));
  }

  public absoluteSpecPath(rootDirectoryPath: string, specPath: string): string {
    return resolve(rootDirectoryPath, ...specPath.split('/'));
  }

  public uniqueSortedSpecPaths(specPaths: readonly string[]): readonly string[] {
    return [
      ...new Set(specPaths),
    ].sort();
  }

  public normalizeRelativePath(path: string): string {
    const normalizedPath = path.replaceAll('\\', '/');

    if (normalizedPath.startsWith('./')) {
      return normalizedPath.slice(2);
    }

    return normalizedPath;
  }

  public isInsideOrSame(rootDirectoryPath: string, targetPath: string): boolean {
    const relativePath = relative(rootDirectoryPath, targetPath);

    return '' === relativePath || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.fileSystem.exists(path);
    } catch (error) {
      throw new SpecTargetContextDiscoveryError(path, String(error));
    }
  }

  private async isDirectory(path: string): Promise<boolean> {
    try {
      return await this.fileSystem.isDirectory(path);
    } catch (error) {
      throw new SpecTargetContextDiscoveryError(path, String(error));
    }
  }

  private async validateRootDirectory(rootDirectoryPath: string): Promise<void> {
    if (!await this.exists(rootDirectoryPath)) {
      throw new SpecTargetContextRootNotFoundError(rootDirectoryPath);
    }

    if (!await this.isDirectory(rootDirectoryPath)) {
      throw new SpecTargetContextRootNotDirectoryError(rootDirectoryPath);
    }
  }

  private fileTargetSpecPaths(
    rootDirectoryPath: string,
    targetPath: string,
    allRelativeSpecPaths: readonly string[],
  ): SpecTargetContextTargetSpecResult {
    const targetDirectoryPath = this.relativeDirectoryPath(rootDirectoryPath, dirname(targetPath));
    const targetSpecName = `${basename(targetPath, extname(targetPath))}.sdd`;
    const candidates = allRelativeSpecPaths.filter((specPath) => (
      posix.dirname(specPath) === targetDirectoryPath
      && posix.basename(specPath).toLowerCase() === targetSpecName.toLowerCase()
    ));
    const exactMatch = candidates.find((specPath) => posix.basename(specPath) === targetSpecName);

    if (undefined !== exactMatch) {
      return {
        ambiguities: [],
        specPaths: [
          exactMatch,
        ],
      };
    }

    if (1 < candidates.length) {
      return {
        ambiguities: [
          {
            specPaths: candidates,
            targetPath: this.relativePath(rootDirectoryPath, targetPath),
          },
        ],
        specPaths: candidates,
      };
    }

    return {
      ambiguities: [],
      specPaths: candidates,
    };
  }

  private async knownDirectoryPaths(
    rootDirectoryPath: string,
    specs: readonly SpecTargetContextPathLike[],
  ): Promise<readonly string[]> {
    const directoryPaths = new Set<string>();

    this.addDirectoryAndAncestors(directoryPaths, '.');

    for (const spec of specs) {
      this.addDirectoryAndAncestors(directoryPaths, spec.directoryPath);
    }

    for (const spec of specs) {
      const parentHeldDirectoryPath = this.parentHeldDirectoryPath(spec.path);

      if (await this.isKnownDirectory(rootDirectoryPath, parentHeldDirectoryPath)) {
        this.addDirectoryAndAncestors(directoryPaths, parentHeldDirectoryPath);
      }
    }

    return [
      ...directoryPaths,
    ];
  }

  private async isKnownDirectory(rootDirectoryPath: string, directoryPath: string): Promise<boolean> {
    return await this.exists(this.absoluteDirectoryPath(rootDirectoryPath, directoryPath))
      && await this.isDirectory(this.absoluteDirectoryPath(rootDirectoryPath, directoryPath));
  }

  private relativeDirectoryChain(rootDirectoryPath: string, targetDirectoryPath: string): readonly string[] {
    const directoryPaths: string[] = [];
    let currentDirectoryPath = targetDirectoryPath;

    while (true) {
      directoryPaths.push(this.relativeDirectoryPath(rootDirectoryPath, currentDirectoryPath));

      if (currentDirectoryPath === rootDirectoryPath) {
        break;
      }

      currentDirectoryPath = dirname(currentDirectoryPath);
    }

    return directoryPaths.reverse();
  }

  private addDirectoryAndAncestors(directoryPaths: Set<string>, directoryPath: string): void {
    let currentDirectoryPath = directoryPath;

    while (true) {
      directoryPaths.add(currentDirectoryPath);

      if ('.' === currentDirectoryPath) {
        return;
      }

      currentDirectoryPath = posix.dirname(currentDirectoryPath);
    }
  }

  private parentHeldDirectoryPath(specPath: string): string {
    const directoryPath = posix.dirname(specPath);
    const specBasename = this.specBasename(specPath);

    if ('.' === directoryPath) {
      return specBasename;
    }

    return posix.join(directoryPath, specBasename);
  }

  private specBasename(specPath: string): string {
    return posix.basename(specPath).slice(0, -'.sdd'.length);
  }
}
