import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  DirectoryCheckerDependency,
  FileExistenceDependency,
  FileReaderDependency,
} from '../../infrastructure/file-system.js';
import { FileSystem } from '../../infrastructure/file-system.js';
import {
  SpecParser,
  SpecParserSyntaxError,
} from '../spec-parser/spec-parser.js';
import {
  SpecLintDiscoveryError,
  SpecLinter,
  SpecLintTargetNotDirectoryError,
  SpecLintTargetNotFoundError,
  type SpecLintPathFinder,
} from './spec-linter.js';

type MemoryFileSystemOptions = {
  readonly directories?: readonly string[];
  readonly existingPaths?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
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

const targetDirectoryPath = resolve('/workspace/project');

const specContent = (title: string, purpose: string | null = null): string => {
  return `Spec: ${title}
${null === purpose ? '' : `Purpose:
  ${purpose}
`}`;
};

const createSpecLinter = (
  options: {
    readonly directories?: readonly string[];
    readonly files?: Readonly<Record<string, string>>;
    readonly findSpecPaths?: SpecLintPathFinder;
    readonly existingPaths?: readonly string[];
    readonly existenceFailure?: Error | null;
    readonly directoryFailure?: Error | null;
  } = {},
): { fileSystem: MemoryFileSystem; specLinter: SpecLinter } => {
  const fileSystem = new MemoryFileSystem({
    directories: options.directories ?? [
      targetDirectoryPath,
    ],
    ...(undefined === options.existingPaths ? {} : {
      existingPaths: options.existingPaths,
    }),
    files: options.files ?? {},
    existenceFailure: options.existenceFailure ?? null,
    directoryFailure: options.directoryFailure ?? null,
  });
  const specLinter = new SpecLinter(
    fileSystem,
    new SpecParser(fileSystem),
    options.findSpecPaths ?? (async () => []),
  );

  return {
    fileSystem,
    specLinter,
  };
};

describe('SpecLinter', () => {
  it('builds a clean deterministic lint tree with directory-level specs', async () => {
    const files = {
      [join(targetDirectoryPath, 'app.sdd')]: specContent('App'),
      [join(targetDirectoryPath, 'billing', 'billing.sdd')]: specContent('Billing', 'Own billing.'),
      [join(targetDirectoryPath, 'billing', 'invoice.sdd')]: specContent('Invoice', 'Own invoices.'),
      [join(targetDirectoryPath, 'catalog', 'Catalog.sdd')]: specContent('Catalog', 'Own catalog.'),
      [join(targetDirectoryPath, 'catalog', 'item.sdd')]: specContent('Item', 'Own items.'),
    };
    const { fileSystem, specLinter } = createSpecLinter({
      files,
      findSpecPaths: async () => [
        'billing/invoice.sdd',
        './app.sdd',
        'catalog\\item.sdd',
        'billing/billing.sdd',
        'catalog/Catalog.sdd',
      ],
    });

    const result = await specLinter.lint({
      targetDirectoryPath,
    });

    expect(result).toMatchObject({
      diagnostics: [],
      errorCount: 0,
      filesChecked: 5,
      ok: true,
      targetDirectoryPath,
      warningCount: 0,
    });
    expect(result.root).toMatchObject({
      name: 'project',
      path: '.',
      spec: null,
      type: 'directory',
    });
    expect(result.root.children.map((child) => child.path)).toEqual([
      'app.sdd',
      'billing',
      'catalog',
    ]);
    expect(result.root.children[1]).toMatchObject({
      path: 'billing',
      spec: {
        diagnostics: [],
        directoryLevel: true,
        path: 'billing/billing.sdd',
      },
      type: 'directory',
    });
    expect(fileSystem.checkedExistencePaths).toEqual([
      targetDirectoryPath,
    ]);
    expect(fileSystem.checkedDirectoryPaths).toEqual([
      targetDirectoryPath,
    ]);
    expect(fileSystem.readFilePaths).toEqual([
      join(targetDirectoryPath, 'app.sdd'),
      join(targetDirectoryPath, 'billing', 'billing.sdd'),
      join(targetDirectoryPath, 'billing', 'invoice.sdd'),
      join(targetDirectoryPath, 'catalog', 'Catalog.sdd'),
      join(targetDirectoryPath, 'catalog', 'item.sdd'),
    ]);
  });

  it('accumulates parse, read, and directory-level ambiguity diagnostics without stopping early', async () => {
    const files = {
      [join(targetDirectoryPath, 'bad.sdd')]: `Purpose:
  Missing Spec first.
Spec : Bad
Tasks:
  ordinary text
`,
      [join(targetDirectoryPath, 'Billing', 'BILLING.sdd')]: specContent('Upper Billing'),
      [join(targetDirectoryPath, 'Billing', 'billing.sdd')]: specContent('Lower Billing'),
      [join(targetDirectoryPath, 'ok.sdd')]: specContent('Ok'),
    };
    const { specLinter } = createSpecLinter({
      files,
      findSpecPaths: async () => [
        'ok.sdd',
        'missing.sdd',
        'Billing/billing.sdd',
        'bad.sdd',
        'Billing/BILLING.sdd',
      ],
    });

    const result = await specLinter.lint({
      targetDirectoryPath,
    });

    expect(result.ok).toBe(false);
    expect(result.filesChecked).toBe(5);
    expect(result.errorCount).toBe(6);
    expect(result.warningCount).toBe(0);
    expect(result.diagnostics.map((diagnostic) => [
      diagnostic.path,
      diagnostic.code,
      diagnostic.lineNumber ?? null,
    ])).toEqual([
      [
        'Billing/BILLING.sdd',
        'directory-spec',
        null,
      ],
      [
        'Billing/billing.sdd',
        'directory-spec',
        null,
      ],
      [
        'bad.sdd',
        'syntax',
        1,
      ],
      [
        'bad.sdd',
        'syntax',
        3,
      ],
      [
        'bad.sdd',
        'syntax',
        5,
      ],
      [
        'missing.sdd',
        'read',
        null,
      ],
    ]);
    expect(result.diagnostics[2]?.message).toBe('SpecDD files should start with the Spec section');
    expect(result.diagnostics[3]?.message).toBe("Section 'Spec' is missing ':'");
    expect(result.diagnostics[4]?.message).toBe('Invalid SpecDD syntax');
    expect(result.diagnostics[1]?.message).toBe(
      'Ambiguous directory-level SpecDD specs for Billing: Billing/BILLING.sdd, Billing/billing.sdd',
    );
    expect(result.root.children.map((child) => child.path)).toEqual([
      'bad.sdd',
      'Billing',
      'missing.sdd',
      'ok.sdd',
    ]);
  });

  it('prefers exact directory-level spec matches over lowercase matches', async () => {
    const files = {
      [join(targetDirectoryPath, 'Billing', 'Billing.sdd')]: specContent('Exact Billing'),
      [join(targetDirectoryPath, 'Billing', 'billing.sdd')]: specContent('Lower Billing'),
    };
    const { specLinter } = createSpecLinter({
      files,
      findSpecPaths: async () => [
        'Billing/billing.sdd',
        'Billing/Billing.sdd',
      ],
    });

    const result = await specLinter.lint({
      targetDirectoryPath,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.root.children[0]).toMatchObject({
      path: 'Billing',
      spec: {
        directoryLevel: true,
        path: 'Billing/Billing.sdd',
      },
      type: 'directory',
    });
  });

  it('turns unknown parser failures into read diagnostics and keeps linting', async () => {
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
      ],
    });
    const specLinter = new SpecLinter(
      fileSystem,
      {
        validateFile: async () => {
          throw 'raw failure';
        },
      },
      async () => [
        'unknown.sdd',
      ],
    );

    await expect(specLinter.lint({
      targetDirectoryPath,
    })).resolves.toMatchObject({
      diagnostics: [
        {
          code: 'read',
          message: 'raw failure',
          path: 'unknown.sdd',
          severity: 'error',
        },
      ],
      errorCount: 1,
      ok: false,
    });
  });

  it('supports syntax diagnostics without a structured line number', async () => {
    const fileSystem = new MemoryFileSystem({
      directories: [
        targetDirectoryPath,
      ],
    });
    const specLinter = new SpecLinter(
      fileSystem,
      {
        validateFile: async () => {
          return [
            new SpecParserSyntaxError('custom syntax error'),
          ];
        },
      },
      async () => [
        'custom.sdd',
      ],
    );

    await expect(specLinter.lint({
      targetDirectoryPath,
    })).resolves.toMatchObject({
      diagnostics: [
        {
          code: 'syntax',
          message: 'custom syntax error',
          path: 'custom.sdd',
          severity: 'error',
        },
      ],
      errorCount: 1,
      ok: false,
    });
  });

  it('returns an empty clean result when no specs are discovered', async () => {
    const { specLinter } = createSpecLinter();

    await expect(specLinter.lint({
      targetDirectoryPath,
    })).resolves.toEqual({
      diagnostics: [],
      errorCount: 0,
      filesChecked: 0,
      ok: true,
      root: {
        children: [],
        name: 'project',
        path: '.',
        spec: null,
        type: 'directory',
      },
      targetDirectoryPath,
      warningCount: 0,
    });
  });

  it('discovers .sdd files through the default fast-glob finder', async () => {
    const temporaryDirectoryPath = await mkdtemp(join(tmpdir(), 'spec-linter-'));

    try {
      await mkdir(join(temporaryDirectoryPath, 'nested'));
      await writeFile(join(temporaryDirectoryPath, 'nested', 'feature.sdd'), specContent('Feature', 'Found.'));
      await writeFile(join(temporaryDirectoryPath, 'nested', 'notes.txt'), 'Spec: Notes\n');

      const fileSystem = new FileSystem();
      const specLinter = new SpecLinter(
        fileSystem,
        new SpecParser(fileSystem),
      );
      const result = await specLinter.lint({
        targetDirectoryPath: temporaryDirectoryPath,
      });

      expect(result.filesChecked).toBe(1);
      expect(result.root.children).toHaveLength(1);
      expect(result.root.children[0]).toMatchObject({
        path: 'nested',
        type: 'directory',
      });
    } finally {
      await rm(temporaryDirectoryPath, {
        force: true,
        recursive: true,
      });
    }
  });

  it('raises when the target path is missing or is not a directory', async () => {
    await expect(createSpecLinter({
      directories: [],
      existingPaths: [],
    }).specLinter.lint({
      targetDirectoryPath,
    })).rejects.toBeInstanceOf(SpecLintTargetNotFoundError);

    await expect(createSpecLinter({
      directories: [],
      existingPaths: [
        targetDirectoryPath,
      ],
    }).specLinter.lint({
      targetDirectoryPath,
    })).rejects.toBeInstanceOf(SpecLintTargetNotDirectoryError);
  });

  it('wraps target validation and discovery failures', async () => {
    await expect(createSpecLinter({
      existenceFailure: new Error('exists failed'),
    }).specLinter.lint({
      targetDirectoryPath,
    })).rejects.toThrow(SpecLintDiscoveryError);

    await expect(createSpecLinter({
      directoryFailure: new Error('stat failed'),
    }).specLinter.lint({
      targetDirectoryPath,
    })).rejects.toThrow(SpecLintDiscoveryError);

    await expect(createSpecLinter({
      findSpecPaths: async () => {
        throw new Error('glob failed');
      },
    }).specLinter.lint({
      targetDirectoryPath,
    })).rejects.toThrow('Failed to discover SpecDD specs under /workspace/project: Error: glob failed');
  });
});
