import { join, resolve } from 'node:path';
import type {
  DirectoryCheckerDependency,
  FileExistenceDependency,
} from '../../infrastructure/file-system.js';
import {
  SpecTargetContext,
  SpecTargetContextDiscoveryError,
  SpecTargetContextRootNotDirectoryError,
  SpecTargetContextRootNotFoundError,
  SpecTargetContextTargetNotFoundError,
  SpecTargetContextTargetOutsideRootError,
} from './spec-target-context.js';

type MemoryFileSystemOptions = {
  readonly directories?: readonly string[];
  readonly existingPaths?: readonly string[];
  readonly existenceFailure?: Error | null;
  readonly directoryFailure?: Error | null;
};

class MemoryFileSystem implements DirectoryCheckerDependency, FileExistenceDependency {
  public readonly checkedExistencePaths: string[] = [];

  public readonly checkedDirectoryPaths: string[] = [];

  private readonly directories: Set<string>;

  private readonly existingPaths: Set<string>;

  private readonly existenceFailure: Error | null;

  private readonly directoryFailure: Error | null;

  public constructor(options: MemoryFileSystemOptions = {}) {
    this.directories = new Set(options.directories ?? []);
    this.existingPaths = new Set([
      ...(options.existingPaths ?? []),
      ...(options.directories ?? []),
    ]);
    this.existenceFailure = options.existenceFailure ?? null;
    this.directoryFailure = options.directoryFailure ?? null;
  }

  public async exists(path: string): Promise<boolean> {
    this.checkedExistencePaths.push(path);

    if (null !== this.existenceFailure) {
      throw this.existenceFailure;
    }

    return this.existingPaths.has(path);
  }

  public async isDirectory(path: string): Promise<boolean> {
    this.checkedDirectoryPaths.push(path);

    if (null !== this.directoryFailure) {
      throw this.directoryFailure;
    }

    return this.directories.has(path);
  }
}

class FailingPathFileSystem extends MemoryFileSystem {
  private readonly failingPath: string;

  public constructor(failingPath: string, options: MemoryFileSystemOptions = {}) {
    super(options);
    this.failingPath = failingPath;
  }

  public override async exists(path: string): Promise<boolean> {
    if (path === this.failingPath) {
      throw new Error('lookup failed');
    }

    return super.exists(path);
  }
}

const rootDirectoryPath = resolve('/workspace/project');
const srcDirectoryPath = join(rootDirectoryPath, 'src');
const featureFilePath = join(srcDirectoryPath, 'feature.ts');
const featureSpecPath = join(srcDirectoryPath, 'feature.sdd');

describe('SpecTargetContext', () => {
  it('resolves target kinds and preferred roots', async () => {
    const context = new SpecTargetContext(new MemoryFileSystem({
      directories: [
        rootDirectoryPath,
        srcDirectoryPath,
      ],
      existingPaths: [
        featureFilePath,
        featureSpecPath,
      ],
    }));

    await expect(context.resolveTarget(rootDirectoryPath)).resolves.toEqual({
      directoryPath: rootDirectoryPath,
      kind: 'directory',
      path: rootDirectoryPath,
    });
    await expect(context.resolveTarget(featureSpecPath)).resolves.toEqual({
      directoryPath: srcDirectoryPath,
      kind: 'spec',
      path: featureSpecPath,
    });

    const fileTarget = await context.resolveTarget(featureFilePath);

    expect(fileTarget).toEqual({
      directoryPath: srcDirectoryPath,
      kind: 'file',
      path: featureFilePath,
    });
    await expect(context.resolvePreferredRootDirectoryPath(undefined, fileTarget)).resolves.toBe(srcDirectoryPath);
    await expect(context.resolvePreferredRootDirectoryPath(resolve('/workspace/other'), fileTarget)).resolves.toBe(srcDirectoryPath);
    await expect(context.resolvePreferredRootDirectoryPath(rootDirectoryPath, fileTarget)).resolves.toBe(rootDirectoryPath);
    await expect(context.resolveRequiredRootAndTarget(rootDirectoryPath, featureFilePath)).resolves.toEqual({
      rootDirectoryPath,
      target: fileTarget,
    });
  });

  it('raises target and root validation errors', async () => {
    const context = new SpecTargetContext(new MemoryFileSystem({
      directories: [
        rootDirectoryPath,
      ],
      existingPaths: [
        featureFilePath,
      ],
    }));

    await expect(context.resolveTarget(join(rootDirectoryPath, 'missing.ts'))).rejects.toBeInstanceOf(
      SpecTargetContextTargetNotFoundError,
    );
    await expect(context.resolveRequiredRootAndTarget(rootDirectoryPath, resolve('/workspace/other/file.ts'))).rejects.toBeInstanceOf(
      SpecTargetContextTargetNotFoundError,
    );
    await expect(context.resolveRequiredRootAndTarget(resolve('/workspace/missing'), featureFilePath)).rejects.toBeInstanceOf(
      SpecTargetContextRootNotFoundError,
    );

    const rootFileContext = new SpecTargetContext(new MemoryFileSystem({
      directories: [
        srcDirectoryPath,
      ],
      existingPaths: [
        rootDirectoryPath,
        featureFilePath,
      ],
    }));

    await expect(rootFileContext.resolveRequiredRootAndTarget(rootDirectoryPath, featureFilePath)).rejects.toBeInstanceOf(
      SpecTargetContextRootNotDirectoryError,
    );

    const outsideContext = new SpecTargetContext(new MemoryFileSystem({
      directories: [
        rootDirectoryPath,
      ],
      existingPaths: [
        resolve('/workspace/other/file.ts'),
      ],
    }));

    await expect(outsideContext.resolveRequiredRootAndTarget(rootDirectoryPath, resolve('/workspace/other/file.ts'))).rejects.toBeInstanceOf(
      SpecTargetContextTargetOutsideRootError,
    );
  });

  it('wraps filesystem lookup failures', async () => {
    await expect(new SpecTargetContext(new MemoryFileSystem({
      existenceFailure: new Error('exists failed'),
    })).resolveTarget(featureFilePath)).rejects.toBeInstanceOf(SpecTargetContextDiscoveryError);

    await expect(new SpecTargetContext(new MemoryFileSystem({
      directoryFailure: new Error('stat failed'),
      existingPaths: [
        featureFilePath,
      ],
    })).resolveTarget(featureFilePath)).rejects.toBeInstanceOf(SpecTargetContextDiscoveryError);
  });

  it('matches upward context, exact directory context, target specs, and recursive specs', () => {
    const context = new SpecTargetContext(new MemoryFileSystem());
    const barDirectoryPath = join(rootDirectoryPath, 'src', 'foo', 'bar');
    const allRelativeSpecPaths = [
      'project.sdd',
      'src/src.sdd',
      'src/foo/bar.sdd',
      'src/foo/bar/bar.sdd',
      'src/foo/bar/exact.sdd',
      'src/foo/bar/feature.sdd',
      'src/foo/bar/FEATURE.sdd',
      'src/foo/bar/helper.sdd',
      'src/other/other.sdd',
    ];

    expect(context.contextSpecPaths(rootDirectoryPath, barDirectoryPath, allRelativeSpecPaths)).toEqual({
      ambiguities: [],
      matches: [
        {
          directoryPath: '.',
          placement: 'local',
          specPath: 'project.sdd',
        },
        {
          directoryPath: 'src',
          placement: 'local',
          specPath: 'src/src.sdd',
        },
        {
          directoryPath: 'src/foo/bar',
          placement: 'parent',
          specPath: 'src/foo/bar.sdd',
        },
        {
          directoryPath: 'src/foo/bar',
          placement: 'local',
          specPath: 'src/foo/bar/bar.sdd',
        },
      ],
    });
    expect(context.directorySpecMatches(rootDirectoryPath, join(rootDirectoryPath, 'Billing'), [
      'billing.sdd',
      'BILLING.sdd',
    ])).toEqual({
      ambiguities: [
        {
          directoryPath: 'Billing',
          placement: 'parent',
          specPaths: [
            'billing.sdd',
            'BILLING.sdd',
          ],
        },
      ],
      matches: [],
    });
    expect(context.targetSpecPaths(rootDirectoryPath, {
      directoryPath: barDirectoryPath,
      kind: 'spec',
      path: join(barDirectoryPath, 'helper.sdd'),
    }, allRelativeSpecPaths)).toEqual({
      ambiguities: [],
      specPaths: [
        'src/foo/bar/helper.sdd',
      ],
    });
    expect(context.targetSpecPaths(rootDirectoryPath, {
      directoryPath: barDirectoryPath,
      kind: 'directory',
      path: barDirectoryPath,
    }, allRelativeSpecPaths)).toEqual({
      ambiguities: [],
      specPaths: [],
    });
    expect(context.targetSpecPaths(rootDirectoryPath, {
      directoryPath: barDirectoryPath,
      kind: 'file',
      path: join(barDirectoryPath, 'exact.ts'),
    }, allRelativeSpecPaths)).toEqual({
      ambiguities: [],
      specPaths: [
        'src/foo/bar/exact.sdd',
      ],
    });
    expect(context.targetSpecPaths(rootDirectoryPath, {
      directoryPath: barDirectoryPath,
      kind: 'file',
      path: join(barDirectoryPath, 'Feature.ts'),
    }, allRelativeSpecPaths)).toEqual({
      ambiguities: [
        {
          specPaths: [
            'src/foo/bar/feature.sdd',
            'src/foo/bar/FEATURE.sdd',
          ],
          targetPath: 'src/foo/bar/Feature.ts',
        },
      ],
      specPaths: [
        'src/foo/bar/feature.sdd',
        'src/foo/bar/FEATURE.sdd',
      ],
    });
    expect(context.targetSpecPaths(rootDirectoryPath, {
      directoryPath: barDirectoryPath,
      kind: 'file',
      path: join(barDirectoryPath, 'missing.ts'),
    }, allRelativeSpecPaths)).toEqual({
      ambiguities: [],
      specPaths: [],
    });
    expect(context.recursiveSpecPaths(rootDirectoryPath, join(rootDirectoryPath, 'src', 'foo'), allRelativeSpecPaths)).toEqual([
      'src/foo/bar.sdd',
      'src/foo/bar/bar.sdd',
      'src/foo/bar/exact.sdd',
      'src/foo/bar/feature.sdd',
      'src/foo/bar/FEATURE.sdd',
      'src/foo/bar/helper.sdd',
    ]);
  });

  it('matches directory context for parsed spec sets', async () => {
    const context = new SpecTargetContext(new MemoryFileSystem({
      directories: [
        rootDirectoryPath,
        srcDirectoryPath,
        join(rootDirectoryPath, 'src', 'foo'),
        join(rootDirectoryPath, 'src', 'foo', 'bar'),
        join(rootDirectoryPath, 'src', 'foo', 'bar', 'helper'),
      ],
    }));

    await expect(context.directoryContextMatches(rootDirectoryPath, [
      {
        directoryPath: '.',
        path: 'project.sdd',
      },
      {
        directoryPath: 'src',
        path: 'src/src.sdd',
      },
      {
        directoryPath: 'src/foo',
        path: 'src/foo/bar.sdd',
      },
      {
        directoryPath: 'src/foo/bar',
        path: 'src/foo/bar/bar.sdd',
      },
      {
        directoryPath: 'src/foo/bar',
        path: 'src/foo/bar/helper.sdd',
      },
    ])).resolves.toEqual({
      ambiguities: [],
      matches: [
        {
          directoryPath: '.',
          placement: 'local',
          specPath: 'project.sdd',
        },
        {
          directoryPath: 'src',
          placement: 'local',
          specPath: 'src/src.sdd',
        },
        {
          directoryPath: 'src/foo/bar',
          placement: 'parent',
          specPath: 'src/foo/bar.sdd',
        },
        {
          directoryPath: 'src/foo/bar',
          placement: 'local',
          specPath: 'src/foo/bar/bar.sdd',
        },
        {
          directoryPath: 'src/foo/bar/helper',
          placement: 'parent',
          specPath: 'src/foo/bar/helper.sdd',
        },
      ],
    });
  });

  it('reports directory context ambiguities and lookup failures', async () => {
    const context = new SpecTargetContext(new MemoryFileSystem({
      directories: [
        rootDirectoryPath,
        join(rootDirectoryPath, 'Billing'),
      ],
    }));

    await expect(context.directoryContextMatches(rootDirectoryPath, [
      {
        directoryPath: 'Billing',
        path: 'Billing/billing.sdd',
      },
      {
        directoryPath: 'Billing',
        path: 'Billing/BILLING.sdd',
      },
    ])).resolves.toEqual({
      ambiguities: [
        {
          directoryPath: 'Billing',
          placement: 'local',
          specPaths: [
            'Billing/billing.sdd',
            'Billing/BILLING.sdd',
          ],
        },
      ],
      matches: [],
    });

    await expect(new SpecTargetContext(new FailingPathFileSystem(join(rootDirectoryPath, 'feature'), {
      directories: [
        rootDirectoryPath,
      ],
    })).directoryContextMatches(rootDirectoryPath, [
      {
        directoryPath: '.',
        path: 'feature.sdd',
      },
    ])).rejects.toBeInstanceOf(SpecTargetContextDiscoveryError);
  });

  it('normalizes and compares paths', () => {
    const context = new SpecTargetContext(new MemoryFileSystem());

    expect(context.relativeDirectoryPath(rootDirectoryPath, rootDirectoryPath)).toBe('.');
    expect(context.relativeDirectoryPath(rootDirectoryPath, join(rootDirectoryPath, 'src'))).toBe('src');
    expect(context.relativeSpecPath(rootDirectoryPath, join(rootDirectoryPath, 'src', 'feature.sdd'))).toBe('src/feature.sdd');
    expect(context.relativePath(rootDirectoryPath, join(rootDirectoryPath, 'src', 'feature.ts'))).toBe('src/feature.ts');
    expect(context.absoluteDirectoryPath(rootDirectoryPath, 'src/foo')).toBe(join(rootDirectoryPath, 'src', 'foo'));
    expect(context.absoluteSpecPath(rootDirectoryPath, 'src/feature.sdd')).toBe(join(rootDirectoryPath, 'src', 'feature.sdd'));
    expect(context.uniqueSortedSpecPaths([
      'b.sdd',
      'a.sdd',
      'b.sdd',
    ])).toEqual([
      'a.sdd',
      'b.sdd',
    ]);
    expect(context.normalizeRelativePath('./src\\feature.sdd')).toBe('src/feature.sdd');
    expect(context.normalizeRelativePath('src\\feature.sdd')).toBe('src/feature.sdd');
    expect(context.isInsideOrSame(rootDirectoryPath, rootDirectoryPath)).toBe(true);
    expect(context.isInsideOrSame(rootDirectoryPath, join(rootDirectoryPath, 'src'))).toBe(true);
    expect(context.isInsideOrSame(rootDirectoryPath, resolve('/workspace/other'))).toBe(false);
  });
});
