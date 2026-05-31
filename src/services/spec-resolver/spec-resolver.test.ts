import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  basename,
  join,
  resolve,
} from 'node:path';
import type {
  DirectoryCheckerDependency,
  FileExistenceDependency,
  FileReaderDependency,
} from '../../infrastructure/file-system.js';
import { SpecParser } from '../spec-parser/spec-parser.js';
import {
  SpecResolveAmbiguousTargetSpecError,
  SpecResolveAmbiguousDirectorySpecError,
  SpecResolveDiscoveryError,
  SpecResolver,
  SpecResolveRootNotDirectoryError,
  SpecResolveRootNotFoundError,
  SpecResolveTargetNotFoundError,
  SpecResolveTargetOutsideRootError,
  type SpecResolvePathFinder,
} from './spec-resolver.js';

type MemoryFileSystemOptions = {
  readonly directories?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  readonly existingPaths?: readonly string[];
  readonly existenceFailure?: Error | null;
  readonly directoryFailure?: Error | null;
};

class MemoryFileSystem implements DirectoryCheckerDependency, FileExistenceDependency, FileReaderDependency {
  public readonly checkedExistencePaths: string[] = [];

  public readonly checkedDirectoryPaths: string[] = [];

  public readonly readFilePaths: string[] = [];

  private readonly directories: Set<string>;

  private readonly existingPaths: Set<string>;

  private readonly files: Map<string, Uint8Array>;

  private readonly existenceFailure: Error | null;

  private readonly directoryFailure: Error | null;

  public constructor(options: MemoryFileSystemOptions = {}) {
    this.directories = new Set(options.directories ?? []);
    this.existingPaths = new Set([
      ...(options.existingPaths ?? []),
      ...(options.directories ?? []),
      ...Object.keys(options.files ?? {}),
    ]);
    this.files = new Map(Object.entries(options.files ?? {}).map(([path, content]) => [
      path,
      new TextEncoder().encode(content),
    ]));
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

  public async readFile(path: string): Promise<Uint8Array> {
    this.readFilePaths.push(path);

    const file = this.files.get(path);

    if (undefined === file) {
      throw new Error(`File not found: ${path}`);
    }

    return file;
  }
}

class PathFailureFileSystem extends MemoryFileSystem {
  private readonly failingDirectoryPath: string | null;

  private readonly failingExistencePath: string | null;

  public constructor(
    options: MemoryFileSystemOptions,
    failures: {
      readonly directoryPath?: string;
      readonly existencePath?: string;
    },
  ) {
    super(options);
    this.failingDirectoryPath = failures.directoryPath ?? null;
    this.failingExistencePath = failures.existencePath ?? null;
  }

  public override async exists(path: string): Promise<boolean> {
    if (path === this.failingExistencePath) {
      throw new Error('exists failed');
    }

    return super.exists(path);
  }

  public override async isDirectory(path: string): Promise<boolean> {
    if (path === this.failingDirectoryPath) {
      throw new Error('stat failed');
    }

    return super.isDirectory(path);
  }
}

const rootDirectoryPath = resolve('/workspace/project');

const specContent = (
  title: string,
  purpose: string,
  extra: string = '',
): string => {
  return `Spec: ${title}
Purpose:
  ${purpose}
${extra}`;
};

const createPathFinder = (files: Readonly<Record<string, string>>): SpecResolvePathFinder => {
  return async (cwd, pattern) => {
    return Object.keys(files).filter((path) => matchesPattern(cwd, pattern, path));
  };
};

const matchesPattern = (cwd: string, pattern: string, path: string): boolean => {
  if (pattern.endsWith('/**/*.sdd')) {
    const absolutePrefix = resolve(cwd, pattern.slice(0, -'/**/*.sdd'.length));

    return path.startsWith(`${absolutePrefix}/`) && path.endsWith('.sdd');
  }

  if (pattern.endsWith('/**')) {
    const absolutePrefix = resolve(cwd, pattern.slice(0, -'/**'.length));

    return path.startsWith(`${absolutePrefix}/`);
  }

  if (!path.startsWith(`${cwd}/`) && path !== cwd) {
    return false;
  }

  const relativePath = path.slice(cwd.length + 1);

  if ('*.sdd' === pattern) {
    return relativePath.endsWith('.sdd') && !relativePath.includes('/');
  }

  if ('**/*.sdd' === pattern) {
    return relativePath.endsWith('.sdd');
  }

  return path === resolve(cwd, pattern);
};

const createResolver = (
  options: MemoryFileSystemOptions = {},
  findSpecPaths: SpecResolvePathFinder | null = null,
): { fileSystem: MemoryFileSystem; specResolver: SpecResolver } => {
  const fileSystem = new MemoryFileSystem(options);

  return {
    fileSystem,
    specResolver: new SpecResolver(
      fileSystem,
      new SpecParser(fileSystem),
      findSpecPaths ?? createPathFinder(options.files ?? {}),
    ),
  };
};

const baseFiles = (): Readonly<Record<string, string>> => {
  return {
    [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.', `Can modify:
  ./everything/**
`),
    [resolve(rootDirectoryPath, 'feature', 'feature.sdd')]: specContent('Feature', 'Own feature behavior.', `Can read:
  ../shared/**
References:
  /rooted/rooted.sdd
Can modify:
  ./local.sdd
Forbids:
  ../forbidden/**
Exposes:
  ../exposed/**
`),
    [resolve(rootDirectoryPath, 'feature', 'local.sdd')]: specContent('Local', 'Describe a local helper.'),
    [resolve(rootDirectoryPath, 'shared', 'shared.sdd')]: specContent('Shared', 'Share reusable behavior.', `Depends on:
  ../deep/deep.sdd
`),
    [resolve(rootDirectoryPath, 'deep', 'deep.sdd')]: specContent('Deep', 'Describe deeper context.'),
    [resolve(rootDirectoryPath, 'rooted', 'rooted.sdd')]: specContent('Rooted', 'Describe rooted context.'),
    [resolve(rootDirectoryPath, 'everything', 'everything.sdd')]: specContent('Everything', 'Would be too broad by default.'),
    [resolve(rootDirectoryPath, 'forbidden', 'forbidden.sdd')]: specContent('Forbidden', 'Must not be followed.'),
    [resolve(rootDirectoryPath, 'exposed', 'exposed.sdd')]: specContent('Exposed', 'Must not be followed.'),
  };
};

const baseDirectories = (): readonly string[] => {
  return [
    rootDirectoryPath,
    resolve(rootDirectoryPath, 'deep'),
    resolve(rootDirectoryPath, 'everything'),
    resolve(rootDirectoryPath, 'exposed'),
    resolve(rootDirectoryPath, 'feature'),
    resolve(rootDirectoryPath, 'forbidden'),
    resolve(rootDirectoryPath, 'rooted'),
    resolve(rootDirectoryPath, 'shared'),
  ];
};

describe('SpecResolver', () => {
  it('resolves parent context and depth-1 soft links from the target anchor only', async () => {
    const files = baseFiles();
    const { fileSystem, specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 1,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result).toMatchObject({
      linkDepth: 1,
      rootDirectoryPath,
      sectionNames: [
        'Purpose',
      ],
      targetDirectoryPath: resolve(rootDirectoryPath, 'feature'),
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });
    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'feature/local.sdd',
      'project.sdd',
      'rooted/rooted.sdd',
      'shared/shared.sdd',
    ]);
    expect(result.specs.find((spec) => 'project.sdd' === spec.path)?.reasons).toEqual([
      {
        directoryPath: '.',
        kind: 'parent',
      },
    ]);
    expect(result.specs.find((spec) => 'feature/feature.sdd' === spec.path)?.reasons).toEqual([
      {
        kind: 'target',
      },
    ]);
    expect(result.specs.find((spec) => 'shared/shared.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'Can read',
        target: '../shared/**',
      },
    ]);
    expect(result.specs.map((spec) => spec.path)).not.toContain('deep/deep.sdd');
    expect(result.specs.map((spec) => spec.path)).not.toContain('everything/everything.sdd');
    expect(result.specs.map((spec) => spec.path)).not.toContain('forbidden/forbidden.sdd');
    expect(result.specs.map((spec) => spec.path)).not.toContain('exposed/exposed.sdd');
    expect(result.root.children.map((child) => child.path)).toEqual([
      'feature',
      'rooted',
      'shared',
    ]);
    expect(fileSystem.readFilePaths).toEqual([
      resolve(rootDirectoryPath, 'project.sdd'),
      resolve(rootDirectoryPath, 'feature', 'feature.sdd'),
      resolve(rootDirectoryPath, 'shared', 'shared.sdd'),
      resolve(rootDirectoryPath, 'rooted', 'rooted.sdd'),
      resolve(rootDirectoryPath, 'feature', 'local.sdd'),
    ]);
  });

  it('defaults to depth 2 and expands immediate parent context links', async () => {
    const files = {
      ...baseFiles(),
      [resolve(rootDirectoryPath, 'shared', 'shared.sdd')]: specContent('Shared', 'Share reusable behavior.', `Depends on:
  ../deep/deep.sdd
`),
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result).toMatchObject({
      linkDepth: 2,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });
    expect(result.specs.map((spec) => spec.path)).toEqual([
      'deep/deep.sdd',
      'everything/everything.sdd',
      'feature/feature.sdd',
      'feature/local.sdd',
      'project.sdd',
      'rooted/rooted.sdd',
      'shared/shared.sdd',
    ]);
    expect(result.specs.find((spec) => 'everything/everything.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 2,
        fromPath: 'project.sdd',
        kind: 'link',
        sectionName: 'Can modify',
        target: './everything/**',
      },
    ]);
  });

  it('supports depth 0, numeric recursive depth, and all depth with cycle protection', async () => {
    const files = {
      ...baseFiles(),
      [resolve(rootDirectoryPath, 'deep', 'deep.sdd')]: specContent('Deep', 'Describe deeper context.', `References:
  ../feature/feature.sdd
`),
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    await expect(specResolver.resolve({
      linkDepth: 0,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    })).resolves.toMatchObject({
      specs: [
        {
          path: 'feature/feature.sdd',
        },
        {
          path: 'project.sdd',
        },
      ],
    });
    await expect(specResolver.resolve({
      linkDepth: 2,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    })).resolves.toMatchObject({
      specs: expect.arrayContaining([
        expect.objectContaining({
          path: 'deep/deep.sdd',
        }),
      ]),
    });
    await expect(specResolver.resolve({
      linkDepth: 'all',
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    })).resolves.toMatchObject({
      specs: expect.arrayContaining([
        expect.objectContaining({
          path: 'deep/deep.sdd',
        }),
        expect.objectContaining({
          path: 'feature/feature.sdd',
        }),
      ]),
    });
  });

  it('uses target .sdd files as anchors and supports requested sections', async () => {
    const files = {
      ...baseFiles(),
      [resolve(rootDirectoryPath, 'feature', 'local.sdd')]: specContent('Local', 'Describe a local helper.', `Must:
  Link to rooted context.
References:
  /rooted/rooted.sdd
`),
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 1,
      rootDirectoryPath,
      sectionNames: [
        'Purpose',
        'Must',
      ],
      targetPath: resolve(rootDirectoryPath, 'feature', 'local.sdd'),
    });

    expect(result.sectionNames).toEqual([
      'Purpose',
      'Must',
    ]);
    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'feature/local.sdd',
      'project.sdd',
      'rooted/rooted.sdd',
    ]);
    expect(result.specs.find((spec) => 'feature/feature.sdd' === spec.path)?.reasons).toEqual([
      {
        directoryPath: 'feature',
        kind: 'parent',
      },
    ]);
    expect(result.specs.find((spec) => 'feature/local.sdd' === spec.path)?.sections.Must?.[0]?.body).toBe('Link to rooted context.');
  });

  it('marks a targeted directory-level .sdd file as the target once', async () => {
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files: baseFiles(),
    });

    const result = await specResolver.resolve({
      linkDepth: 0,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature', 'feature.sdd'),
    });

    expect(result.specs.find((spec) => 'feature/feature.sdd' === spec.path)?.reasons).toEqual([
      {
        kind: 'target',
      },
    ]);
  });

  it('keeps parent context when the target directory has no directory-level spec', async () => {
    const files = baseFiles();
    const { specResolver } = createResolver({
      directories: [
        ...baseDirectories(),
        resolve(rootDirectoryPath, 'feature', 'nested'),
      ],
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 0,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature', 'nested'),
    });

    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'project.sdd',
    ]);
    expect(result.specs.find((spec) => 'feature/feature.sdd' === spec.path)?.reasons).toEqual([
      {
        directoryPath: 'feature',
        kind: 'parent',
      },
    ]);
  });

  it('uses a single lowercase directory spec match when exact case is absent', async () => {
    const reportDirectoryPath = resolve(rootDirectoryPath, 'Reports');
    const files = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.'),
      [resolve(reportDirectoryPath, 'reports.sdd')]: specContent('Reports', 'Own report specs.'),
    };
    const { specResolver } = createResolver({
      directories: [
        rootDirectoryPath,
        reportDirectoryPath,
      ],
      files,
    });

    const result = await specResolver.resolve({
      rootDirectoryPath,
      targetPath: reportDirectoryPath,
    });

    expect(result.specs.find((spec) => 'Reports/reports.sdd' === spec.path)).toMatchObject({
      directoryLevel: true,
      reasons: [
        {
          kind: 'target',
        },
      ],
    });
  });

  it('includes parent-held and local directory specs as cumulative vertical context', async () => {
    const barDirectoryPath = resolve(rootDirectoryPath, 'src', 'foo', 'bar');
    const files = {
      [resolve(rootDirectoryPath, 'src', 'foo', 'bar.sdd')]: specContent('Broad Bar', 'Govern bar broadly.'),
      [resolve(barDirectoryPath, 'bar.sdd')]: specContent('Local Bar', 'Govern bar locally.'),
    };
    const { specResolver } = createResolver({
      directories: [
        rootDirectoryPath,
        resolve(rootDirectoryPath, 'src'),
        resolve(rootDirectoryPath, 'src', 'foo'),
        barDirectoryPath,
      ],
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 0,
      rootDirectoryPath,
      targetPath: barDirectoryPath,
    });

    expect(result.specs.map((spec) => [
      spec.path,
      spec.directoryLevel,
      spec.reasons,
    ])).toEqual([
      [
        'src/foo/bar.sdd',
        true,
        [
          {
            kind: 'target',
          },
        ],
      ],
      [
        'src/foo/bar/bar.sdd',
        true,
        [
          {
            kind: 'target',
          },
        ],
      ],
    ]);
    expect(result.root.children[0]).toMatchObject({
      children: [
        {
          children: [
            {
              path: 'src/foo/bar',
              spec: {
                path: 'src/foo/bar.sdd',
              },
              specs: [
                {
                  path: 'src/foo/bar.sdd',
                },
                {
                  path: 'src/foo/bar/bar.sdd',
                },
              ],
            },
          ],
          path: 'src/foo',
        },
      ],
      path: 'src',
    });
  });

  it('includes parent-held directory specs when resolving explicit directory links', async () => {
    const sharedDirectoryPath = resolve(rootDirectoryPath, 'shared');
    const files = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.'),
      [resolve(rootDirectoryPath, 'feature', 'feature.sdd')]: specContent('Feature', 'Own feature behavior.', `Structure:
  ../shared
`),
      [resolve(rootDirectoryPath, 'shared.sdd')]: specContent('Broad Shared', 'Govern shared broadly.'),
      [resolve(sharedDirectoryPath, 'shared.sdd')]: specContent('Local Shared', 'Govern shared locally.'),
    };
    const { specResolver } = createResolver({
      directories: [
        rootDirectoryPath,
        resolve(rootDirectoryPath, 'feature'),
        sharedDirectoryPath,
      ],
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 1,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'project.sdd',
      'shared.sdd',
      'shared/shared.sdd',
    ]);
    expect(result.specs.find((spec) => 'shared.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'Structure',
        target: '../shared',
      },
    ]);
  });

  it('resolves an empty root context when no root-level spec exists', async () => {
    const { specResolver } = createResolver({
      directories: [
        rootDirectoryPath,
      ],
    });

    await expect(specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).resolves.toMatchObject({
      specs: [],
    });
  });

  it('deduplicates repeated explicit links and trims trailing punctuation', async () => {
    const files = {
      ...baseFiles(),
      [resolve(rootDirectoryPath, 'feature', 'feature.sdd')]: specContent('Feature', 'Own feature behavior.', `Can modify:
  ./local.sdd,
  ./local.sdd
`),
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result.specs.find((spec) => 'feature/local.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'Can modify',
        target: './local.sdd',
      },
    ]);
  });

  it('follows explicit links wrapped in backticks and brackets', async () => {
    const files = {
      ...baseFiles(),
      [resolve(rootDirectoryPath, 'feature', 'feature.sdd')]: specContent('Feature', 'Own feature behavior.', `References:
  \`./local.sdd\`
  [../shared/shared.sdd]
  {/rooted/rooted.sdd}
`),
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 1,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'feature/local.sdd',
      'project.sdd',
      'rooted/rooted.sdd',
      'shared/shared.sdd',
    ]);
    expect(result.specs.find((spec) => 'feature/local.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'References',
        target: './local.sdd',
      },
    ]);
    expect(result.specs.find((spec) => 'shared/shared.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'References',
        target: '../shared/shared.sdd',
      },
    ]);
    expect(result.specs.find((spec) => 'rooted/rooted.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'References',
        target: '/rooted/rooted.sdd',
      },
    ]);
  });

  it('resolves explicit non-glob directory links to directory-level specs only', async () => {
    const files = {
      ...baseFiles(),
      [resolve(rootDirectoryPath, 'feature', 'feature.sdd')]: specContent('Feature', 'Own feature behavior.', `Structure:
  ../shared
`),
      [resolve(rootDirectoryPath, 'shared', 'nested', 'nested.sdd')]: specContent('Nested Shared', 'Should require a glob link.'),
    };
    const { specResolver } = createResolver({
      directories: [
        ...baseDirectories(),
        resolve(rootDirectoryPath, 'shared', 'nested'),
      ],
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 1,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result.specs.map((spec) => spec.path)).not.toContain('shared/nested/nested.sdd');
    expect(result.specs.find((spec) => 'shared/shared.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'Structure',
        target: '../shared',
      },
    ]);
  });

  it('follows explicit ordinary file links to same-basename specs', async () => {
    const files = {
      ...baseFiles(),
      [resolve(rootDirectoryPath, 'feature', 'feature.sdd')]: specContent('Feature', 'Own feature behavior.', `Can modify:
  ./local.ts
Can read:
  /shared/shared.ts
References:
  ./notes.txt
`),
      [resolve(rootDirectoryPath, 'feature', 'local.ts')]: 'export {};\n',
      [resolve(rootDirectoryPath, 'feature', 'notes.txt')]: 'no matching spec\n',
      [resolve(rootDirectoryPath, 'shared', 'shared.ts')]: 'export {};\n',
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 1,
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'feature/local.sdd',
      'project.sdd',
      'shared/shared.sdd',
    ]);
    expect(result.specs.find((spec) => 'feature/local.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'Can modify',
        target: './local.ts',
      },
    ]);
    expect(result.specs.find((spec) => 'shared/shared.sdd' === spec.path)?.reasons).toEqual([
      {
        depth: 1,
        fromPath: 'feature/feature.sdd',
        kind: 'link',
        sectionName: 'Can read',
        target: '/shared/shared.ts',
      },
    ]);
  });

  it('ignores unprefixed, remote, outside-root, and non-spec links', async () => {
    const files = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.'),
      [resolve(rootDirectoryPath, 'feature', 'feature.sdd')]: specContent('Feature', 'Own feature behavior.', `References:
  shared/shared.sdd
  https://specdd.ai/docs
  ../../outside/**
  ../../outside.sdd
  ./missing.sdd
  ./notes.txt
`),
      [resolve(rootDirectoryPath, 'feature', 'notes.txt')]: 'not a spec',
      [resolve(rootDirectoryPath, 'shared', 'shared.sdd')]: specContent('Shared', 'Would require a prefixed path.'),
    };
    const { specResolver } = createResolver({
      directories: [
        rootDirectoryPath,
        resolve(rootDirectoryPath, 'feature'),
        resolve(rootDirectoryPath, 'shared'),
      ],
      files,
    });

    const result = await specResolver.resolve({
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'feature'),
    });

    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'project.sdd',
    ]);
  });

  it('raises for ambiguous directory specs discovered through linked context', async () => {
    const billingDirectoryPath = resolve(rootDirectoryPath, 'Billing');
    const files = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.', `References:
  ./Billing/**
`),
      [resolve(billingDirectoryPath, 'BILLING.sdd')]: specContent('Upper Billing', 'Own billing.'),
      [resolve(billingDirectoryPath, 'billing.sdd')]: specContent('Lower Billing', 'Own billing.'),
    };

    await expect(createResolver({
      directories: [
        rootDirectoryPath,
        billingDirectoryPath,
      ],
      files,
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toBeInstanceOf(SpecResolveAmbiguousDirectorySpecError);
  });

  it('uses fast-glob for default spec path discovery', async () => {
    const temporaryRootDirectoryPath = await mkdtemp(join(tmpdir(), 'spec-resolver-'));
    const featureDirectoryPath = resolve(temporaryRootDirectoryPath, 'feature');
    const rootSpecName = `${basename(temporaryRootDirectoryPath)}.sdd`;
    const files = {
      [resolve(temporaryRootDirectoryPath, rootSpecName)]: specContent('App', 'Own the application.'),
      [resolve(featureDirectoryPath, 'feature.sdd')]: specContent('Feature', 'Own feature behavior.'),
    };

    try {
      await mkdir(featureDirectoryPath, {
        recursive: true,
      });

      for (const [path, content] of Object.entries(files)) {
        await writeFile(path, content);
      }

      const fileSystem = new MemoryFileSystem({
        directories: [
          temporaryRootDirectoryPath,
          featureDirectoryPath,
        ],
        files,
      });
      const specResolver = new SpecResolver(
        fileSystem,
        new SpecParser(fileSystem),
      );

      await expect(specResolver.resolve({
        rootDirectoryPath: temporaryRootDirectoryPath,
        targetPath: featureDirectoryPath,
      })).resolves.toMatchObject({
        specs: [
          {
            path: 'feature/feature.sdd',
          },
          {
            path: rootSpecName,
          },
        ],
      });
    } finally {
      await rm(temporaryRootDirectoryPath, {
        force: true,
        recursive: true,
      });
    }
  });

  it('normalizes relative spec paths returned by discovery', async () => {
    const files = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.'),
    };
    const { specResolver } = createResolver({
      directories: [
        rootDirectoryPath,
      ],
      files,
    }, async () => [
      'project.sdd',
    ]);

    await expect(specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).resolves.toMatchObject({
      specs: [
        {
          path: 'project.sdd',
        },
      ],
    });
  });

  it('accepts ordinary file targets with same-basename specs', async () => {
    const targetFilePath = resolve(rootDirectoryPath, 'feature', 'local.ts');
    const files = {
      ...baseFiles(),
      [targetFilePath]: 'export {};\n',
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 0,
      rootDirectoryPath,
      targetPath: targetFilePath,
    });

    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'feature/local.sdd',
      'project.sdd',
    ]);
    expect(result.targetDirectoryPath).toBe(resolve(rootDirectoryPath, 'feature'));
    expect(result.specs.find((spec) => 'feature/local.sdd' === spec.path)?.reasons).toEqual([
      {
        kind: 'target',
      },
    ]);
  });

  it('accepts ordinary file targets without same-basename specs', async () => {
    const targetFilePath = resolve(rootDirectoryPath, 'feature', 'missing-spec.ts');
    const files = {
      ...baseFiles(),
      [targetFilePath]: 'export {};\n',
    };
    const { specResolver } = createResolver({
      directories: baseDirectories(),
      files,
    });

    const result = await specResolver.resolve({
      linkDepth: 0,
      rootDirectoryPath,
      targetPath: targetFilePath,
    });

    expect(result.specs.map((spec) => spec.path)).toEqual([
      'feature/feature.sdd',
      'project.sdd',
    ]);
    expect(result.targetDirectoryPath).toBe(resolve(rootDirectoryPath, 'feature'));
  });

  it('raises when ordinary file target specs are ambiguous', async () => {
    const targetFilePath = resolve(rootDirectoryPath, 'Feature.ts');
    const files = {
      [targetFilePath]: 'export {};\n',
      [resolve(rootDirectoryPath, 'FEATURE.sdd')]: specContent('Upper Feature', 'Upper feature.'),
      [resolve(rootDirectoryPath, 'feature.sdd')]: specContent('Lower Feature', 'Lower feature.'),
    };

    await expect(createResolver({
      directories: [
        rootDirectoryPath,
      ],
      files,
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: targetFilePath,
    })).rejects.toBeInstanceOf(SpecResolveAmbiguousTargetSpecError);
  });

  it('raises for missing and outside-root targets', async () => {
    await expect(createResolver({
      directories: [],
      files: {},
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toBeInstanceOf(SpecResolveRootNotFoundError);
    await expect(createResolver({
      directories: [],
      existingPaths: [
        rootDirectoryPath,
      ],
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toBeInstanceOf(SpecResolveRootNotDirectoryError);
    await expect(createResolver({
      directories: [
        rootDirectoryPath,
      ],
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: resolve(rootDirectoryPath, 'missing'),
    })).rejects.toBeInstanceOf(SpecResolveTargetNotFoundError);
    await expect(createResolver({
      directories: [
        rootDirectoryPath,
        resolve('/workspace/other'),
      ],
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: resolve('/workspace/other'),
    })).rejects.toBeInstanceOf(SpecResolveTargetOutsideRootError);
  });

  it('raises for ambiguous directory specs, discovery failures, and parse failures', async () => {
    const ambiguousDirectoryPath = resolve(rootDirectoryPath, 'Billing');

    await expect(createResolver({
      directories: [
        rootDirectoryPath,
        ambiguousDirectoryPath,
      ],
      files: {
        [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.'),
        [resolve(ambiguousDirectoryPath, 'BILLING.sdd')]: specContent('Upper Billing', 'Own billing.'),
        [resolve(ambiguousDirectoryPath, 'billing.sdd')]: specContent('Lower Billing', 'Own billing.'),
      },
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: ambiguousDirectoryPath,
    })).rejects.toBeInstanceOf(SpecResolveAmbiguousDirectorySpecError);
    await expect(createResolver({
      directories: [
        rootDirectoryPath,
      ],
      existenceFailure: new Error('exists failed'),
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toThrow(SpecResolveDiscoveryError);

    const linkedSpecPath = resolve(rootDirectoryPath, 'linked.sdd');
    const linkedFilePath = resolve(rootDirectoryPath, 'linked');
    const linkedFiles = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.', `References:
  ./linked.sdd
`),
    };
    const linkedExistenceFailureFileSystem = new PathFailureFileSystem({
      directories: [
        rootDirectoryPath,
      ],
      files: linkedFiles,
    }, {
      existencePath: linkedSpecPath,
    });

    await expect(new SpecResolver(
      linkedExistenceFailureFileSystem,
      new SpecParser(linkedExistenceFailureFileSystem),
      createPathFinder(linkedFiles),
    ).resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toThrow(SpecResolveDiscoveryError);

    const linkedDirectoryFiles = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.', `References:
  ./linked
`),
      [linkedFilePath]: 'linked file',
    };
    const linkedDirectoryFailureFileSystem = new PathFailureFileSystem({
      directories: [
        rootDirectoryPath,
      ],
      existingPaths: [
        linkedFilePath,
      ],
      files: linkedDirectoryFiles,
    }, {
      directoryPath: linkedFilePath,
    });

    await expect(new SpecResolver(
      linkedDirectoryFailureFileSystem,
      new SpecParser(linkedDirectoryFailureFileSystem),
      createPathFinder(linkedDirectoryFiles),
    ).resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toThrow(SpecResolveDiscoveryError);

    const directoryContextFailureFiles = {
      [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.'),
    };
    const directoryContextFailureFileSystem = new PathFailureFileSystem({
      directories: [
        rootDirectoryPath,
      ],
      files: directoryContextFailureFiles,
    }, {
      existencePath: resolve(rootDirectoryPath, 'project'),
    });

    await expect(new SpecResolver(
      directoryContextFailureFileSystem,
      new SpecParser(directoryContextFailureFileSystem),
      createPathFinder(directoryContextFailureFiles),
    ).resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toThrow(SpecResolveDiscoveryError);

    await expect(createResolver({
      directories: [
        rootDirectoryPath,
      ],
      directoryFailure: new Error('stat failed'),
      existingPaths: [
        rootDirectoryPath,
      ],
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toThrow(SpecResolveDiscoveryError);
    await expect(createResolver({
      directories: [
        rootDirectoryPath,
      ],
      files: {
        [resolve(rootDirectoryPath, 'project.sdd')]: 'Purpose:\n  Missing Spec first.\n',
      },
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toThrow('Failed to parse SpecDD spec project.sdd');
    await expect(createResolver({
      directories: [
        rootDirectoryPath,
      ],
      files: {
        [resolve(rootDirectoryPath, 'project.sdd')]: specContent('App', 'Own the application.'),
      },
    }, async () => {
      throw new Error('glob failed');
    }).specResolver.resolve({
      rootDirectoryPath,
      targetPath: rootDirectoryPath,
    })).rejects.toThrow(SpecResolveDiscoveryError);
  });
});
