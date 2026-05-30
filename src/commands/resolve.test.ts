import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { SpecSection } from '../services/spec-parser/spec-parser.js';
import type {
  SpecResolveRequest,
  SpecResolveResult,
} from '../services/spec-resolver/spec-resolver.js';
import {
  collectResolveSectionOption,
  createResolveCommand,
  renderResolve,
  resolveResolveDepth,
  resolveResolveOutputFormat,
  resolveResolveRootPath,
  resolveResolveSectionNames,
  resolveResolveTargetPath,
  ResolveInvalidDepthError,
  ResolveInvalidFormatError,
  type ResolveCommandContainer,
} from './resolve.js';

class FakeSpecResolver {
  public readonly requests: SpecResolveRequest[] = [];

  private readonly result: SpecResolveResult;

  private readonly failure: Error | null;

  public constructor(result: SpecResolveResult = createResolveResult(), failure: Error | null = null) {
    this.result = result;
    this.failure = failure;
  }

  public async resolve(request: SpecResolveRequest): Promise<SpecResolveResult> {
    this.requests.push(request);

    if (null !== this.failure) {
      throw this.failure;
    }

    return this.result;
  }
}

const createContainer = (specResolver: FakeSpecResolver): ResolveCommandContainer => {
  return {
    specResolver,
  };
};

const section = (name: string, body: string, inlineValue: string | null = null): SpecSection => {
  return {
    body,
    entries: [],
    inlineValue,
    lineNumber: 1,
    name: name as SpecSection['name'],
  };
};

const createResolveResult = (): SpecResolveResult => {
  const appPurpose = section('Purpose', 'Own the application.');
  const featurePurpose = section('Purpose', 'Own feature behavior.');
  const sharedPurpose = section('Purpose', 'Share behavior.\nAcross features.\n');

  return {
    linkDepth: 1,
    root: {
      children: [
        {
          directoryLevel: false,
          name: 'app.sdd',
          path: 'app.sdd',
          reasons: [
            {
              directoryPath: '.',
              kind: 'parent',
            },
          ],
          sections: {
            Purpose: [
              appPurpose,
            ],
          },
          title: 'App',
          type: 'spec',
        },
        {
          children: [
            {
              directoryLevel: false,
              name: 'helper.sdd',
              path: 'feature/helper.sdd',
              reasons: [
                {
                  depth: 1,
                  fromPath: 'feature/feature.sdd',
                  kind: 'link',
                  sectionName: 'Can modify',
                  target: './**/*.sdd',
                },
              ],
              sections: {
                Purpose: [],
              },
              title: 'Helper',
              type: 'spec',
            },
          ],
          name: 'feature',
          path: 'feature',
          spec: {
            directoryLevel: true,
            name: 'feature.sdd',
            path: 'feature/feature.sdd',
            reasons: [
              {
                kind: 'target',
              },
            ],
            sections: {
              Purpose: [
                featurePurpose,
              ],
            },
            title: 'Feature',
            type: 'spec',
          },
          type: 'directory',
        },
        {
          children: [],
          name: 'shared',
          path: 'shared',
          spec: {
            directoryLevel: true,
            name: 'shared.sdd',
            path: 'shared/shared.sdd',
            reasons: [
              {
                depth: 1,
                fromPath: 'feature/feature.sdd',
                kind: 'link',
                sectionName: 'References',
                target: '../shared/**',
              },
            ],
            sections: {
              Purpose: [
                sharedPurpose,
              ],
            },
            title: 'Shared',
            type: 'spec',
          },
          type: 'directory',
        },
      ],
      name: 'project',
      path: '.',
      spec: null,
      type: 'directory',
    },
    rootDirectoryPath: '/project',
    sectionNames: [
      'Purpose',
    ],
    specs: [],
    targetPath: '/project/feature',
  };
};

const createSparseResolveResult = (): SpecResolveResult => {
  const inlinePurpose = section('Purpose', '\n  \n', 'Inline purpose');

  return {
    linkDepth: 0,
    root: {
      children: [
        {
          directoryLevel: false,
          name: 'alpha.sdd',
          path: 'alpha.sdd',
          reasons: [],
          sections: {},
          title: 'Alpha',
          type: 'spec',
        },
        {
          directoryLevel: false,
          name: 'orphan.sdd',
          path: 'orphan.sdd',
          reasons: [],
          sections: {},
          title: 'Orphan',
          type: 'spec',
        },
        {
          children: [],
          name: 'empty',
          path: 'empty',
          spec: null,
          type: 'directory',
        },
        {
          children: [],
          name: 'feature',
          path: 'feature',
          spec: {
            directoryLevel: true,
            name: 'feature.sdd',
            path: 'feature/feature.sdd',
            reasons: [
              {
                directoryPath: 'feature',
                kind: 'parent',
              },
            ],
            sections: {
              Purpose: [
                inlinePurpose,
              ],
            },
            title: 'Feature',
            type: 'spec',
          },
          type: 'directory',
        },
      ],
      name: 'project',
      path: '.',
      spec: null,
      type: 'directory',
    },
    rootDirectoryPath: '/project',
    sectionNames: [
      'Purpose',
    ],
    specs: [],
    targetPath: '/project/feature',
  };
};

const createEmptyResolveResult = (): SpecResolveResult => {
  return {
    linkDepth: 0,
    root: {
      children: [],
      name: 'project',
      path: '.',
      spec: null,
      type: 'directory',
    },
    rootDirectoryPath: '/project',
    sectionNames: [
      'Purpose',
    ],
    specs: [],
    targetPath: '/project',
  };
};

const renderHelp = (command: Command): string => {
  const messages: string[] = [];

  command.configureOutput({
    writeOut: (message) => {
      messages.push(message);
    },
  });
  command.outputHelp();

  return messages.join('');
};

describe('resolve command', () => {
  it('defines concise help text', () => {
    const specResolver = new FakeSpecResolver();
    const command = createResolveCommand(createContainer(specResolver), () => '/project');
    const targetArgument = command.registeredArguments[0];
    const rootOption = command.options.find((option) => '--root' === option.long);
    const sectionOption = command.options.find((option) => '--section' === option.long);
    const sectionsOption = command.options.find((option) => '--sections' === option.long);
    const depthOption = command.options.find((option) => '--depth' === option.long);
    const formatOption = command.options.find((option) => '--format' === option.long);
    const help = renderHelp(command);

    expect(command.description()).toBe('Resolve relevant SpecDD specs for a target path.');
    expect(targetArgument?.required).toBe(true);
    expect(targetArgument?.description).toBe('Directory or .sdd file to resolve.');
    expect(rootOption?.description).toBe('Root directory for resolution. Defaults to the current directory.');
    expect(sectionOption?.description).toBe('Section to include. May be repeated.');
    expect(sectionsOption?.description).toBe('Comma-separated sections to include.');
    expect(depthOption?.description).toBe('Soft-link expansion depth: non-negative integer or all.');
    expect(depthOption?.defaultValue).toBe('2');
    expect(formatOption?.description).toBe('Output format: text, json, or json-extended.');
    expect(formatOption?.defaultValue).toBe('text');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
  });

  it('resolves target and root paths', () => {
    expect(resolveResolveTargetPath('/project', 'src')).toBe('/project/src');
    expect(resolveResolveTargetPath('/project', '/other')).toBe('/other');
    expect(resolveResolveRootPath('/project', undefined)).toBe('/project');
    expect(resolveResolveRootPath('/project', 'src')).toBe('/project/src');
    expect(resolveResolveRootPath('/project', '/other')).toBe('/other');
  });

  it('resolves requested sections from repeated and comma-separated options', () => {
    expect(collectResolveSectionOption('Purpose', [])).toEqual([
      'Purpose',
    ]);
    expect(resolveResolveSectionNames([], undefined)).toBeUndefined();
    expect(resolveResolveSectionNames([
      'Purpose',
    ], 'Must, Tasks,')).toEqual([
      'Purpose',
      'Must',
      'Tasks',
    ]);
  });

  it('resolves and rejects depth values', () => {
    expect(resolveResolveDepth('0')).toBe(0);
    expect(resolveResolveDepth('2')).toBe(2);
    expect(resolveResolveDepth('all')).toBe('all');
    expect(() => resolveResolveDepth('-1')).toThrow(ResolveInvalidDepthError);
    expect(() => resolveResolveDepth('deep')).toThrow(ResolveInvalidDepthError);
  });

  it('resolves and rejects output formats', () => {
    expect(resolveResolveOutputFormat('text')).toBe('text');
    expect(resolveResolveOutputFormat('json')).toBe('json');
    expect(resolveResolveOutputFormat('json-extended')).toBe('json-extended');
    expect(() => resolveResolveOutputFormat('yaml')).toThrow(ResolveInvalidFormatError);
  });

  it('renders human-readable resolved context', () => {
    expect(renderResolve(createResolveResult(), 'text')).toBe(`/feature/
  feature.sdd
    Purpose:
      Own feature behavior.
  helper.sdd
    Relevant because:
      - feature/feature.sdd can modify ./**/*.sdd

/shared/
  shared.sdd
    Relevant because:
      - feature/feature.sdd references ../shared/**
    Purpose:
      Share behavior.
      Across features.

/
  app.sdd
    Relevant because:
      - Parent context for /
    Purpose:
      Own the application.
`);
  });

  it('renders compact JSON for machine consumers', () => {
    const parsedJson = JSON.parse(renderResolve(createResolveResult(), 'json'));

    expect(parsedJson).toMatchObject({
      linkDepth: 1,
      rootDirectoryPath: '/project',
      sectionNames: [
        'Purpose',
      ],
      targetPath: '/project/feature',
    });
    expect(parsedJson.directories[0].path).toBe('/');
    expect(parsedJson.directories[0].specs[0]).toMatchObject({
      path: 'app.sdd',
      reasons: [
        {
          directoryPath: '.',
          kind: 'parent',
        },
      ],
    });
    expect(parsedJson.directories[2].specs[0].sections.Purpose[0].body).toEqual([
      'Share behavior.',
      'Across features.',
    ]);
    expect(renderResolve(createResolveResult(), 'json')).not.toContain('lineNumber');
    expect(renderResolve(createResolveResult(), 'json')).not.toContain('entries');
  });

  it('omits empty directories and renders inline sections with empty bodies', () => {
    const textOutput = renderResolve(createSparseResolveResult(), 'text');
    const jsonOutput = JSON.parse(renderResolve(createSparseResolveResult(), 'json'));

    expect(textOutput).toBe(`/feature/
  feature.sdd
    Relevant because:
      - Parent context for /feature/
    Purpose: Inline purpose

/
  alpha.sdd
  orphan.sdd
`);
    expect(textOutput).not.toContain('/empty/');
    expect(jsonOutput.directories.map((directory: { path: string }) => directory.path)).toEqual([
      '/',
      '/feature/',
    ]);
    expect(jsonOutput.directories[1].specs[0].sections.Purpose[0]).toEqual({
      body: [],
      inlineValue: 'Inline purpose',
    });
  });

  it('renders empty resolved context as the root directory', () => {
    expect(renderResolve(createEmptyResolveResult(), 'text')).toBe(`/
`);
  });

  it('renders extended JSON for full service result consumers', () => {
    const renderedJson = renderResolve(createResolveResult(), 'json-extended');

    expect(JSON.parse(renderedJson)).toMatchObject({
      root: {
        name: 'project',
      },
      rootDirectoryPath: '/project',
      targetPath: '/project/feature',
    });
    expect(renderedJson).toContain('lineNumber');
    expect(renderedJson).toContain('entries');
  });

  it('rejects unsupported render formats', () => {
    expect(() => renderResolve(createResolveResult(), 'yaml')).toThrow(ResolveInvalidFormatError);
  });

  it('calls spec resolver with defaults and writes text output', async () => {
    const specResolver = new FakeSpecResolver();
    const output: string[] = [];
    const command = createResolveCommand(createContainer(specResolver), () => '/project', (message) => {
      output.push(message);
    });

    await command.parseAsync([
      'src/feature',
    ], {
      from: 'user',
    });

    expect(specResolver.requests).toEqual([
      {
        linkDepth: 2,
        rootDirectoryPath: '/project',
        targetPath: '/project/src/feature',
      },
    ]);
    expect(output.join('')).toMatch(/^\/feature\/\n  feature\.sdd\n    Purpose:/u);
    expect(output.join('')).not.toContain('- target');
  });

  it('calls spec resolver with resolved options and JSON output', async () => {
    const specResolver = new FakeSpecResolver();
    const output: string[] = [];
    const command = createResolveCommand(createContainer(specResolver), () => '/project', (message) => {
      output.push(message);
    });

    await command.parseAsync([
      'src/feature',
      '--root',
      'src',
      '--section',
      'Purpose',
      '--sections',
      'Must,Tasks',
      '--depth',
      'all',
      '--format',
      'json',
    ], {
      from: 'user',
    });

    expect(specResolver.requests).toEqual([
      {
        linkDepth: 'all',
        rootDirectoryPath: '/project/src',
        sectionNames: [
          'Purpose',
          'Must',
          'Tasks',
        ],
        targetPath: '/project/src/feature',
      },
    ]);
    expect(JSON.parse(output.join('')).targetPath).toBe('/project/feature');
  });

  it('uses process cwd and stdout when providers are omitted', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const specResolver = new FakeSpecResolver();
    const command = createResolveCommand(createContainer(specResolver));

    try {
      await command.parseAsync([
        'src/feature',
      ], {
        from: 'user',
      });

      expect(stdoutWrite).toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
      stdoutWrite.mockRestore();
    }

    expect(specResolver.requests).toEqual([
      {
        linkDepth: 2,
        rootDirectoryPath: '/project',
        targetPath: '/project/src/feature',
      },
    ]);
  });

  it('rejects invalid depth and format values before resolving', async () => {
    const specResolver = new FakeSpecResolver();
    const command = createResolveCommand(createContainer(specResolver), () => '/project');

    await expect(command.parseAsync([
      'src/feature',
      '--depth',
      'invalid',
    ], {
      from: 'user',
    })).rejects.toBeInstanceOf(ResolveInvalidDepthError);
    await expect(command.parseAsync([
      'src/feature',
      '--format',
      'yaml',
    ], {
      from: 'user',
    })).rejects.toBeInstanceOf(ResolveInvalidFormatError);
    expect(specResolver.requests).toEqual([]);
  });

  it('propagates spec resolver failures', async () => {
    const failure = new Error('resolve failed');
    const specResolver = new FakeSpecResolver(undefined, failure);
    const command = createResolveCommand(createContainer(specResolver), () => '/project');

    await expect(command.parseAsync([
      'src/feature',
    ], {
      from: 'user',
    })).rejects.toBe(failure);
  });
});
