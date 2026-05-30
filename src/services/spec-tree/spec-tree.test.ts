import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  DirectoryCheckerDependency,
  FileExistenceDependency,
  FileReaderDependency,
} from '../../infrastructure/file-system.js';
import { FileSystem } from '../../infrastructure/file-system.js';
import { SpecParser } from '../spec-parser/spec-parser.js';
import {
  SpecTree,
  SpecTreeAmbiguousDirectorySpecError,
  SpecTreeDiscoveryError,
  SpecTreeParseError,
  SpecTreeTargetNotDirectoryError,
  SpecTreeTargetNotFoundError,
  type SpecTreePathFinder,
} from './spec-tree.js';

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

const specContent = (title: string, purpose: string | null = null, extra = ''): string => {
  return `Spec: ${title}
${null === purpose ? '' : `Purpose:
  ${purpose}
`}${extra}`;
};

const createSpecTree = (
  options: {
    readonly directories?: readonly string[];
    readonly files?: Readonly<Record<string, string>>;
    readonly findSpecPaths?: SpecTreePathFinder;
    readonly existingPaths?: readonly string[];
    readonly existenceFailure?: Error | null;
    readonly directoryFailure?: Error | null;
  } = {},
): { fileSystem: MemoryFileSystem; specTree: SpecTree } => {
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
  const specTree = new SpecTree(
    fileSystem,
    new SpecParser(fileSystem),
    options.findSpecPaths ?? (async () => []),
  );

  return {
    fileSystem,
    specTree,
  };
};

describe('SpecTree', () => {
  it('builds a deterministic tree with default Purpose sections and directory-level specs', async () => {
    const files = {
      [join(targetDirectoryPath, 'app.sdd')]: specContent('App'),
      [join(targetDirectoryPath, 'billing', 'billing.sdd')]: specContent('Billing', 'Own billing.'),
      [join(targetDirectoryPath, 'billing', 'invoice.sdd')]: specContent('Invoice', 'Own invoices.'),
      [join(targetDirectoryPath, 'catalog', 'Catalog.sdd')]: specContent('Catalog', 'Own catalog.'),
      [join(targetDirectoryPath, 'catalog', 'item.sdd')]: specContent('Item', 'Own items.'),
    };
    const { fileSystem, specTree } = createSpecTree({
      files,
      findSpecPaths: async () => [
        'billing/invoice.sdd',
        './app.sdd',
        'catalog\\item.sdd',
        'billing/billing.sdd',
        'catalog/Catalog.sdd',
      ],
    });

    const result = await specTree.build({
      targetDirectoryPath,
    });

    expect(result.targetDirectoryPath).toBe(targetDirectoryPath);
    expect(result.sectionNames).toEqual([
      'Purpose',
    ]);
    expect(result.specs.map((spec) => [
      spec.path,
      spec.directoryLevel,
    ])).toEqual([
      [
        'app.sdd',
        false,
      ],
      [
        'billing/billing.sdd',
        true,
      ],
      [
        'billing/invoice.sdd',
        false,
      ],
      [
        'catalog/Catalog.sdd',
        true,
      ],
      [
        'catalog/item.sdd',
        false,
      ],
    ]);
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
    expect(result.root.children[0]).toMatchObject({
      directoryLevel: false,
      path: 'app.sdd',
      sections: {
        Purpose: [],
      },
      title: 'App',
      type: 'spec',
    });
    expect(result.root.children[1]).toMatchObject({
      path: 'billing',
      spec: {
        directoryLevel: true,
        path: 'billing/billing.sdd',
        sections: {
          Purpose: [
            {
              body: 'Own billing.',
            },
          ],
        },
        title: 'Billing',
      },
      type: 'directory',
    });
    expect(result.root.children[1]?.type).toBe('directory');

    if ('directory' === result.root.children[1]?.type) {
      expect(result.root.children[1].children).toHaveLength(1);
      expect(result.root.children[1].children[0]).toMatchObject({
        directoryLevel: false,
        path: 'billing/invoice.sdd',
        title: 'Invoice',
      });
    }

    expect(result.root.children[2]).toMatchObject({
      path: 'catalog',
      spec: {
        directoryLevel: true,
        path: 'catalog/Catalog.sdd',
        title: 'Catalog',
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

  it('attaches requested sections in request order', async () => {
    const files = {
      [join(targetDirectoryPath, 'feature.sdd')]: specContent('Feature', 'Do work.', `Scenario: first
  Given work exists
Tasks:
  [x] Done.
`),
    };
    const { specTree } = createSpecTree({
      files,
      findSpecPaths: async () => [
        'feature.sdd',
      ],
    });

    const result = await specTree.build({
      sectionNames: [
        'Tasks',
        'Missing',
        'Scenario',
        'Purpose',
      ],
      targetDirectoryPath,
    });

    expect(Object.keys(result.specs[0]?.sections ?? {})).toEqual([
      'Tasks',
      'Missing',
      'Scenario',
      'Purpose',
    ]);
    expect(result.specs[0]?.sections.Missing).toEqual([]);
    expect(result.specs[0]?.sections.Tasks?.[0]?.body).toBe('Done.');
    expect(result.specs[0]?.sections.Scenario?.[0]?.inlineValue).toBe('first');
  });

  it('prefers exact directory-level spec matches over lowercase matches', async () => {
    const files = {
      [join(targetDirectoryPath, 'Billing', 'Billing.sdd')]: specContent('Exact Billing'),
      [join(targetDirectoryPath, 'Billing', 'billing.sdd')]: specContent('Lower Billing'),
    };
    const { specTree } = createSpecTree({
      files,
      findSpecPaths: async () => [
        'Billing/billing.sdd',
        'Billing/Billing.sdd',
      ],
    });

    const result = await specTree.build({
      targetDirectoryPath,
    });

    expect(result.specs.map((spec) => [
      spec.path,
      spec.directoryLevel,
    ])).toEqual([
      [
        'Billing/Billing.sdd',
        true,
      ],
      [
        'Billing/billing.sdd',
        false,
      ],
    ]);
  });

  it('returns an empty tree when no specs are discovered', async () => {
    const { specTree } = createSpecTree();

    await expect(specTree.build({
      targetDirectoryPath,
    })).resolves.toEqual({
      root: {
        children: [],
        name: 'project',
        path: '.',
        spec: null,
        type: 'directory',
      },
      sectionNames: [
        'Purpose',
      ],
      specs: [],
      targetDirectoryPath,
    });
  });

  it('discovers .sdd files through the default fast-glob finder', async () => {
    const temporaryDirectoryPath = await mkdtemp(join(tmpdir(), 'spec-tree-'));

    try {
      await mkdir(join(temporaryDirectoryPath, 'nested'));
      await writeFile(join(temporaryDirectoryPath, 'nested', 'feature.sdd'), specContent('Feature', 'Found.'));
      await writeFile(join(temporaryDirectoryPath, 'nested', 'notes.txt'), 'Spec: Notes\n');

      const fileSystem = new FileSystem();
      const specTree = new SpecTree(
        fileSystem,
        new SpecParser(fileSystem),
      );
      const result = await specTree.build({
        targetDirectoryPath: temporaryDirectoryPath,
      });

      expect(result.specs.map((spec) => spec.path)).toEqual([
        'nested/feature.sdd',
      ]);
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
    await expect(createSpecTree({
      directories: [],
      existingPaths: [],
    }).specTree.build({
      targetDirectoryPath,
    })).rejects.toBeInstanceOf(SpecTreeTargetNotFoundError);

    await expect(createSpecTree({
      directories: [],
      existingPaths: [
        targetDirectoryPath,
      ],
    }).specTree.build({
      targetDirectoryPath,
    })).rejects.toBeInstanceOf(SpecTreeTargetNotDirectoryError);
  });

  it('wraps target validation and discovery failures', async () => {
    await expect(createSpecTree({
      existenceFailure: new Error('exists failed'),
    }).specTree.build({
      targetDirectoryPath,
    })).rejects.toThrow(SpecTreeDiscoveryError);

    await expect(createSpecTree({
      directoryFailure: new Error('stat failed'),
    }).specTree.build({
      targetDirectoryPath,
    })).rejects.toThrow(SpecTreeDiscoveryError);

    await expect(createSpecTree({
      findSpecPaths: async () => {
        throw new Error('glob failed');
      },
    }).specTree.build({
      targetDirectoryPath,
    })).rejects.toThrow('Failed to discover SpecDD specs under /workspace/project: Error: glob failed');
  });

  it('raises when lowercase directory-level spec matches are ambiguous', async () => {
    const files = {
      [join(targetDirectoryPath, 'Billing', 'BILLING.sdd')]: specContent('Upper Billing'),
      [join(targetDirectoryPath, 'Billing', 'billing.sdd')]: specContent('Lower Billing'),
    };
    const { specTree } = createSpecTree({
      files,
      findSpecPaths: async () => [
        'Billing/BILLING.sdd',
        'Billing/billing.sdd',
      ],
    });

    await expect(specTree.build({
      targetDirectoryPath,
    })).rejects.toThrow(SpecTreeAmbiguousDirectorySpecError);
  });

  it('wraps parser failures with the relative spec path', async () => {
    const files = {
      [join(targetDirectoryPath, 'bad.sdd')]: 'Purpose:\n  Missing spec.\n',
    };
    const { specTree } = createSpecTree({
      files,
      findSpecPaths: async () => [
        'bad.sdd',
      ],
    });

    await expect(specTree.build({
      targetDirectoryPath,
    })).rejects.toThrow(SpecTreeParseError);
    await expect(specTree.build({
      targetDirectoryPath,
    })).rejects.toThrow('Failed to parse SpecDD spec bad.sdd: SpecParserSyntaxError: SpecDD files should start with the Spec section at line 1 in /workspace/project/bad.sdd.');
  });
});
