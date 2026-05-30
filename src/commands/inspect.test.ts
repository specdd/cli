import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { SpecSection } from '../services/spec-parser/spec-parser.js';
import type {
  SpecTreeRequest,
  SpecTreeResult,
} from '../services/spec-tree/spec-tree.js';
import {
  collectInspectSectionOption,
  createInspectCommand,
  renderInspect,
  resolveInspectOutputFormat,
  resolveInspectSectionNames,
  resolveInspectTargetPath,
  InspectInvalidFormatError,
  type InspectCommandContainer,
} from './inspect.js';

class FakeSpecTree {
  public readonly requests: SpecTreeRequest[] = [];

  private readonly result: SpecTreeResult;

  private readonly failure: Error | null;

  public constructor(result: SpecTreeResult = createSpecTreeResult(), failure: Error | null = null) {
    this.result = result;
    this.failure = failure;
  }

  public async build(request: SpecTreeRequest): Promise<SpecTreeResult> {
    this.requests.push(request);

    if (null !== this.failure) {
      throw this.failure;
    }

    return this.result;
  }
}

const createContainer = (specTree: FakeSpecTree): InspectCommandContainer => {
  return {
    specTree,
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

const createSpecTreeResult = (): SpecTreeResult => {
  const billingPurpose = section('Purpose', 'Own billing workflows.');
  const invoicePurpose = section('Purpose', 'Own invoices.\nValidate totals.');
  const scenario = section('Scenario', 'Given invoice input', 'valid invoice');

  return {
    root: {
      children: [
        {
          directoryLevel: false,
          name: 'app.sdd',
          path: 'app.sdd',
          sections: {
            Purpose: [],
            Scenario: [],
          },
          title: 'App',
          type: 'spec',
        },
        {
          children: [
            {
              directoryLevel: false,
              name: 'invoice.sdd',
              path: 'billing/invoice.sdd',
              sections: {
                Purpose: [
                  invoicePurpose,
                ],
                Scenario: [
                  scenario,
                ],
              },
              title: 'Invoice',
              type: 'spec',
            },
          ],
          name: 'billing',
          path: 'billing',
          spec: {
            directoryLevel: true,
            name: 'billing.sdd',
            path: 'billing/billing.sdd',
            sections: {
              Purpose: [
                billingPurpose,
              ],
              Scenario: [],
            },
            title: 'Billing',
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
    sectionNames: [
      'Purpose',
      'Scenario',
    ],
    specs: [],
    targetDirectoryPath: '/project',
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

describe('inspect command', () => {
  it('defines concise help text', () => {
    const specTree = new FakeSpecTree();
    const command = createInspectCommand(createContainer(specTree), () => '/project');
    const pathArgument = command.registeredArguments[0];
    const sectionOption = command.options.find((option) => '--section' === option.long);
    const sectionsOption = command.options.find((option) => '--sections' === option.long);
    const formatOption = command.options.find((option) => '--format' === option.long);
    const help = renderHelp(command);

    expect(command.description()).toBe('Inspect SpecDD spec files and selected sections.');
    expect(pathArgument?.description).toBe('Directory to inspect. Defaults to the current directory.');
    expect(sectionOption?.description).toBe('Section to include. May be repeated.');
    expect(sectionsOption?.description).toBe('Comma-separated sections to include.');
    expect(formatOption?.description).toBe('Output format: text, json, or json-extended.');
    expect(formatOption?.defaultValue).toBe('text');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
  });

  it('resolves target paths', () => {
    expect(resolveInspectTargetPath('/project', undefined)).toBe('/project');
    expect(resolveInspectTargetPath('/project', 'src')).toBe('/project/src');
    expect(resolveInspectTargetPath('/project', '/other')).toBe('/other');
  });

  it('resolves requested sections from repeated and comma-separated options', () => {
    expect(collectInspectSectionOption('Purpose', [])).toEqual([
      'Purpose',
    ]);
    expect(resolveInspectSectionNames([], undefined)).toBeUndefined();
    expect(resolveInspectSectionNames([
      'Purpose',
    ], 'Must, Tasks,')).toEqual([
      'Purpose',
      'Must',
      'Tasks',
    ]);
  });

  it('resolves and rejects output formats', () => {
    expect(resolveInspectOutputFormat('text')).toBe('text');
    expect(resolveInspectOutputFormat('json')).toBe('json');
    expect(resolveInspectOutputFormat('json-extended')).toBe('json-extended');
    expect(() => resolveInspectOutputFormat('yaml')).toThrow(InspectInvalidFormatError);
  });

  it('renders a human-readable text tree', () => {
    expect(renderInspect(createSpecTreeResult(), 'text')).toBe(`/
  app.sdd

/billing/
  billing.sdd
    Purpose:
      Own billing workflows.
  invoice.sdd
    Purpose:
      Own invoices.
      Validate totals.
    Scenario: valid invoice
      Given invoice input
`);
  });

  it('renders section headers without bodies', () => {
    const result = createSpecTreeResult();
    const resultWithEmptySection: SpecTreeResult = {
      ...result,
      root: {
        ...result.root,
        children: [
          {
            directoryLevel: false,
            name: 'empty.sdd',
            path: 'empty.sdd',
            sections: {
              Purpose: [
                section('Purpose', ''),
              ],
            },
            title: 'Empty',
            type: 'spec',
          },
          ...result.root.children,
        ],
      },
    };

    expect(renderInspect(resultWithEmptySection, 'text')).toContain(`  empty.sdd
    Purpose:
`);
  });

  it('trims section body lines in compact JSON and text output', () => {
    const result: SpecTreeResult = {
      ...createSpecTreeResult(),
      root: {
        children: [
          {
            directoryLevel: false,
            name: 'trimmed.sdd',
            path: 'trimmed.sdd',
            sections: {
              Purpose: [
                section('Purpose', '\n  First line.  \n  Second line.  \n\n'),
              ],
            },
            title: 'Trimmed',
            type: 'spec',
          },
        ],
        name: 'project',
        path: '.',
        spec: null,
        type: 'directory',
      },
      sectionNames: [
        'Purpose',
      ],
    };

    expect(renderInspect(result, 'text')).toContain(`    Purpose:
      First line.
      Second line.
`);
    expect(JSON.parse(renderInspect(result, 'json')).directories[0].specs[0].sections.Purpose).toEqual([
      {
        body: [
          'First line.',
          'Second line.',
        ],
      },
    ]);
  });

  it('omits intermediate directory blocks without direct specs', () => {
    const result = createSpecTreeResult();
    const resultWithIntermediateDirectory: SpecTreeResult = {
      ...result,
      root: {
        ...result.root,
        children: [
          ...result.root.children,
          {
            children: [
              {
                children: [
                  {
                    directoryLevel: false,
                    name: 'feature.sdd',
                    path: 'parent/child/feature.sdd',
                    sections: {
                      Purpose: [
                        section('Purpose', 'Own child feature.'),
                      ],
                    },
                    title: 'Feature',
                    type: 'spec',
                  },
                ],
                name: 'child',
                path: 'parent/child',
                spec: null,
                type: 'directory',
              },
            ],
            name: 'parent',
            path: 'parent',
            spec: null,
            type: 'directory',
          },
        ],
      },
    };
    const text = renderInspect(resultWithIntermediateDirectory, 'text');
    const compactJson = JSON.parse(renderInspect(resultWithIntermediateDirectory, 'json'));

    expect(text).not.toContain('/parent/\n\n');
    expect(text).toContain(`/parent/child/
  feature.sdd
    Purpose:
      Own child feature.
`);
    expect(compactJson.directories.map((directory: { path: string }) => directory.path)).not.toContain('/parent/');
    expect(compactJson.directories.map((directory: { path: string }) => directory.path)).toContain('/parent/child/');
  });

  it('renders compact JSON for machine consumers by default', () => {
    const renderedJson = renderInspect(createSpecTreeResult(), 'json');
    const parsedJson = JSON.parse(renderedJson);

    expect(parsedJson).toEqual({
      directories: [
        {
          path: '/',
          specs: [
            {
              directoryLevel: false,
              name: 'app.sdd',
              path: 'app.sdd',
              sections: {
                Purpose: [],
                Scenario: [],
              },
              title: 'App',
            },
          ],
        },
        {
          path: '/billing/',
          specs: [
            {
              directoryLevel: true,
              name: 'billing.sdd',
              path: 'billing/billing.sdd',
              sections: {
                Purpose: [
                  {
                    body: [
                      'Own billing workflows.',
                    ],
                  },
                ],
                Scenario: [],
              },
              title: 'Billing',
            },
            {
              directoryLevel: false,
              name: 'invoice.sdd',
              path: 'billing/invoice.sdd',
              sections: {
                Purpose: [
                  {
                    body: [
                      'Own invoices.',
                      'Validate totals.',
                    ],
                  },
                ],
                Scenario: [
                  {
                    body: [
                      'Given invoice input',
                    ],
                    inlineValue: 'valid invoice',
                  },
                ],
              },
              title: 'Invoice',
            },
          ],
        },
      ],
      sectionNames: [
        'Purpose',
        'Scenario',
      ],
      targetDirectoryPath: '/project',
    });
    expect(renderedJson).not.toContain('lineNumber');
    expect(renderedJson).not.toContain('entries');
  });

  it('renders extended JSON for full service result consumers', () => {
    const renderedJson = renderInspect(createSpecTreeResult(), 'json-extended');

    expect(JSON.parse(renderedJson)).toMatchObject({
      root: {
        name: 'project',
      },
      sectionNames: [
        'Purpose',
        'Scenario',
      ],
      targetDirectoryPath: '/project',
    });
    expect(renderedJson).toContain('lineNumber');
    expect(renderedJson).toContain('entries');
  });

  it('rejects unsupported render formats', () => {
    expect(() => renderInspect(createSpecTreeResult(), 'yaml')).toThrow(InspectInvalidFormatError);
  });

  it('calls spec tree with the current working directory and writes text by default', async () => {
    const specTree = new FakeSpecTree();
    const output: string[] = [];
    const command = createInspectCommand(createContainer(specTree), () => '/project', (message) => {
      output.push(message);
    });

    await command.parseAsync([], {
      from: 'user',
    });

    expect(specTree.requests).toEqual([
      {
        targetDirectoryPath: '/project',
      },
    ]);
    expect(output.join('').startsWith('/\n')).toBe(true);
  });

  it('calls spec tree with resolved target path, requested sections, and JSON output', async () => {
    const specTree = new FakeSpecTree();
    const output: string[] = [];
    const command = createInspectCommand(createContainer(specTree), () => '/project', (message) => {
      output.push(message);
    });

    await command.parseAsync([
      'src',
      '--section',
      'Purpose',
      '--section',
      'Must',
      '--sections',
      'Tasks,Scenario',
      '--format',
      'json',
    ], {
      from: 'user',
    });

    expect(specTree.requests).toEqual([
      {
        sectionNames: [
          'Purpose',
          'Must',
          'Tasks',
          'Scenario',
        ],
        targetDirectoryPath: '/project/src',
      },
    ]);
    expect(JSON.parse(output.join('')).directories[0].path).toBe('/');
  });

  it('calls spec tree with extended JSON output', async () => {
    const specTree = new FakeSpecTree();
    const output: string[] = [];
    const command = createInspectCommand(createContainer(specTree), () => '/project', (message) => {
      output.push(message);
    });

    await command.parseAsync([
      '--format',
      'json-extended',
    ], {
      from: 'user',
    });

    expect(JSON.parse(output.join(''))).toMatchObject({
      root: {
        name: 'project',
      },
    });
  });

  it('uses process cwd and stdout when providers are omitted', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const specTree = new FakeSpecTree();
    const command = createInspectCommand(createContainer(specTree));

    try {
      await command.parseAsync([
      ], {
        from: 'user',
      });

      expect(stdoutWrite).toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
      stdoutWrite.mockRestore();
    }

    expect(specTree.requests).toEqual([
      {
        targetDirectoryPath: '/project',
      },
    ]);
  });

  it('rejects invalid formats before building the tree', async () => {
    const specTree = new FakeSpecTree();
    const command = createInspectCommand(createContainer(specTree), () => '/project');

    await expect(command.parseAsync([
      '--format',
      'yaml',
    ], {
      from: 'user',
    })).rejects.toBeInstanceOf(InspectInvalidFormatError);
    expect(specTree.requests).toEqual([]);
  });

  it('propagates spec tree build errors', async () => {
    const failure = new Error('tree failed');
    const specTree = new FakeSpecTree(undefined, failure);
    const command = createInspectCommand(createContainer(specTree), () => '/project');

    await expect(command.parseAsync([], {
      from: 'user',
    })).rejects.toBe(failure);
  });
});
