import type { FileReaderDependency } from '../../infrastructure/file-system.js';
import {
  SpecParser,
  SpecParserDuplicateSectionError,
  SpecParserReadError,
  SpecParserSyntaxError,
} from './spec-parser.js';

class MemoryFileSystem implements FileReaderDependency {
  public readonly readFilePaths: string[] = [];

  private readonly files: Map<string, Uint8Array>;

  private readonly readFailure: Error | null;

  public constructor(options: {
    files?: Readonly<Record<string, string>>;
    readFailure?: Error | null;
  } = {}) {
    this.files = new Map(Object.entries(options.files ?? {}).map(([path, content]) => [
      path,
      new TextEncoder().encode(content),
    ]));
    this.readFailure = options.readFailure ?? null;
  }

  public async readFile(path: string): Promise<Uint8Array> {
    this.readFilePaths.push(path);

    if (null !== this.readFailure) {
      throw this.readFailure;
    }

    const file = this.files.get(path);

    if (undefined === file) {
      throw new Error(`File not found: ${path}`);
    }

    return file;
  }
}

const createParser = (fileSystem = new MemoryFileSystem()): SpecParser => {
  return new SpecParser(fileSystem);
};

describe('SpecParser', () => {
  it('parses a valid spec into sections, lookup entries, and semantic body text', () => {
    const parser = createParser();
    const document = parser.parseContent({
      content: `# leading comment
Spec: Billing Service
Platform: TypeScript/Node

Purpose:
  Own billing workflows
    across invoices.
  Keep docs fresh.
  # ignored comment
Structure:
  ./src: Source code
    and tests.
  key:
  empty: 
Tasks:
  [ ] #1 Add parser.
  [?] Decide format
    with user.
Scenario: valid flow
  Given a spec
    with continuation
  Andromeda remains text.
Example:
  output: ok
Example: named
  plain example text
`,
      sourcePath: '/project/billing.sdd',
    });

    expect(document.title).toBe('Billing Service');
    expect(document.sourcePath).toBe('/project/billing.sdd');
    expect(document.sections.map((section) => section.name)).toEqual([
      'Spec',
      'Platform',
      'Purpose',
      'Structure',
      'Tasks',
      'Scenario',
      'Example',
      'Example',
    ]);
    expect(document.sectionLookup.Purpose?.[0]?.body).toBe(
      'Own billing workflows across invoices.\nKeep docs fresh.',
    );
    expect(document.sectionLookup.Structure?.[0]?.entries).toEqual([
      {
        keyValue: {
          key: './src',
          value: 'Source code and tests.',
        },
        kind: 'key-value',
        lineNumber: 11,
        rawLines: [
          '  ./src: Source code',
          '    and tests.',
        ],
        text: './src: Source code and tests.',
      },
      {
        kind: 'text',
        lineNumber: 13,
        rawLines: [
          '  key:',
        ],
        text: 'key:',
      },
      {
        keyValue: {
          key: 'empty',
          value: '',
        },
        kind: 'key-value',
        lineNumber: 14,
        rawLines: [
          '  empty: ',
        ],
        text: 'empty:',
      },
    ]);
    expect(document.sectionLookup.Tasks?.[0]?.entries).toEqual([
      {
        kind: 'task',
        lineNumber: 16,
        rawLines: [
          '  [ ] #1 Add parser.',
        ],
        task: {
          id: '#1',
          marker: '[ ]',
          status: 'open',
          text: 'Add parser.',
        },
        text: 'Add parser.',
      },
      {
        kind: 'task',
        lineNumber: 17,
        rawLines: [
          '  [?] Decide format',
          '    with user.',
        ],
        task: {
          id: null,
          marker: '[?]',
          status: 'question',
          text: 'Decide format with user.',
        },
        text: 'Decide format with user.',
      },
    ]);
    expect(document.sectionLookup.Scenario?.[0]?.entries).toEqual([
      {
        kind: 'scenario-step',
        lineNumber: 20,
        rawLines: [
          '  Given a spec',
          '    with continuation',
        ],
        scenarioStep: {
          keyword: 'Given',
          text: 'a spec with continuation',
        },
        text: 'Given a spec with continuation',
      },
      {
        kind: 'text',
        lineNumber: 22,
        rawLines: [
          '  Andromeda remains text.',
        ],
        text: 'Andromeda remains text.',
      },
    ]);
    expect(document.sectionLookup.Example).toHaveLength(2);
    expect(document.sectionLookup.Example?.[1]?.inlineValue).toBe('named');
  });

  it('parses a file from disk with its source path', async () => {
    const specPath = '/project/service.sdd';
    const fileSystem = new MemoryFileSystem({
      files: {
        [specPath]: `Spec: Service
Purpose:
  Provide behavior.
`,
      },
    });
    const parser = createParser(fileSystem);

    await expect(parser.parseFile({
      path: specPath,
    })).resolves.toMatchObject({
      sourcePath: specPath,
      title: 'Service',
    });
    expect(fileSystem.readFilePaths).toEqual([
      specPath,
    ]);
  });

  it('normalizes CRLF and CR line endings', () => {
    const parser = createParser();

    expect(parser.parseContent({
      content: 'Spec: Example\r\nPurpose:\r  Works.\r',
    })).toMatchObject({
      sectionLookup: {
        Purpose: [
          {
            body: 'Works.',
          },
        ],
        Spec: [
          {
            inlineValue: 'Example',
          },
        ],
      },
    });
  });

  it('ignores blank lines and comments anywhere in the document', () => {
    const parser = createParser();

    expect(parser.parseContent({
      content: `
  # leading comment
Spec: Example
Purpose:
   # odd comment indentation is ignored
  Body entry.

      # deeper comment indentation is ignored
`,
    }).sectionLookup.Purpose?.[0]?.entries).toEqual([
      {
        kind: 'text',
        lineNumber: 6,
        rawLines: [
          '  Body entry.',
        ],
        text: 'Body entry.',
      },
    ]);
  });

  it('raises syntax errors found while parsing file content', async () => {
    const specPath = '/project/bad.sdd';
    const parser = createParser(new MemoryFileSystem({
      files: {
        [specPath]: 'not a section\n',
      },
    }));

    await expect(parser.parseFile({
      path: specPath,
    })).rejects.toBeInstanceOf(SpecParserSyntaxError);
  });

  it('exposes structured syntax error details when available', () => {
    const parser = createParser();
    let syntaxError: unknown;
    let duplicateError: unknown;

    try {
      parser.parseContent({
        content: 'Purpose:\n  Missing Spec first.\n',
        sourcePath: '/project/bad.sdd',
      });
    } catch (error) {
      syntaxError = error;
    }

    expect(syntaxError).toBeInstanceOf(SpecParserSyntaxError);
    expect(syntaxError).toMatchObject({
      description: 'SpecDD files should start with the Spec section',
      lineNumber: 1,
      sourcePath: '/project/bad.sdd',
    });
    expect(new SpecParserSyntaxError('raw syntax error')).toMatchObject({
      description: 'raw syntax error',
      lineNumber: null,
      sourcePath: null,
    });

    try {
      parser.parseContent({
        content: `Spec: Example
Purpose:
  One.
Purpose:
  Two.
`,
        sourcePath: '/project/duplicate.sdd',
      });
    } catch (error) {
      duplicateError = error;
    }

    expect(duplicateError).toMatchObject({
      description: 'Duplicate SpecDD spec section "Purpose"',
      lineNumber: null,
      sourcePath: '/project/duplicate.sdd',
    });
  });

  it('collects multiple visible syntax errors during validation', async () => {
    const specPath = '/project/bad.sdd';
    const content = `Purpose:
  Missing Spec first.
Spec : Bad
Tasks:
  ordinary text
Scenario:
`;
    const parser = createParser(new MemoryFileSystem({
      files: {
        [specPath]: content,
      },
    }));
    const expectedDiagnostics = [
      {
        description: 'SpecDD files should start with the Spec section',
        lineNumber: 1,
        sourcePath: specPath,
      },
      {
        description: "Section 'Spec' is missing ':'",
        lineNumber: 3,
        sourcePath: specPath,
      },
      {
        description: 'Invalid SpecDD syntax',
        lineNumber: 5,
        sourcePath: specPath,
      },
      {
        description: "Section 'Scenario' requires an inline value",
        lineNumber: 6,
        sourcePath: specPath,
      },
    ];

    expect(parser.validateContent({
      content,
      sourcePath: specPath,
    }).map((diagnostic) => ({
      description: diagnostic.description,
      lineNumber: diagnostic.lineNumber,
      sourcePath: diagnostic.sourcePath,
    }))).toEqual(expectedDiagnostics);
    await expect(parser.validateFile({
      path: specPath,
    })).resolves.toMatchObject(expectedDiagnostics);
  });

  it('recovers validation state after invalid inline section text', () => {
    const parser = createParser();

    expect(parser.validateContent({
      content: `Spec: Example Service

Purpose: Coordinate example service behavior.
  Keep service responsibilities explicit for consumers.

Purpose:
  Keep example service responsibilities in one boundary.
`,
      sourcePath: '/project/example.sdd',
    }).map((diagnostic) => ({
      description: diagnostic.description,
      lineNumber: diagnostic.lineNumber,
      sourcePath: diagnostic.sourcePath,
    }))).toEqual([
      {
        description: "Section 'Purpose' does not support inline text after ':'",
        lineNumber: 3,
        sourcePath: '/project/example.sdd',
      },
      {
        description: 'Duplicate SpecDD spec section "Purpose"',
        lineNumber: null,
        sourcePath: '/project/example.sdd',
      },
    ]);
  });

  it('recovers inline-value section state after invalid inline spacing', () => {
    const parser = createParser();

    expect(parser.validateContent({
      content: `Spec:Example
Purpose:
  Explain behavior.
`,
      sourcePath: '/project/spacing.sdd',
    }).map((diagnostic) => [
      diagnostic.description,
      diagnostic.lineNumber,
    ])).toEqual([
      [
        "Inline value for section 'Spec' must be separated from ':' by a space",
        1,
      ],
    ]);
  });

  it('does not recover indented invalid section headers as active sections', () => {
    const parser = createParser();

    expect(parser.validateContent({
      content: `Spec: Example
  Purpose:
`,
      sourcePath: '/project/indented-header.sdd',
    }).map((diagnostic) => [
      diagnostic.description,
      diagnostic.lineNumber,
    ])).toEqual([
      [
        'Section headers must start at column 0',
        2,
      ],
    ]);
  });

  it('continues after a syntax failure that cannot recover a section header', () => {
    const parser = createParser();
    const patchedParser = parser as unknown as {
      parseSectionHeader: () => null;
    };

    patchedParser.parseSectionHeader = () => {
      throw new SpecParserSyntaxError('custom recoverable syntax error');
    };

    expect(parser.validateContent({
      content: 'not a header\n',
      sourcePath: '/project/custom.sdd',
    }).map((diagnostic) => diagnostic.description)).toEqual([
      'custom recoverable syntax error',
      'SpecDD spec must contain a Spec section',
    ]);
  });

  it('recovers across independent validation errors in one file', () => {
    const parser = createParser();

    expect(parser.validateContent({
      content: `# leading comment
  # indented comment
\tbad indentation
loose text
Spec: Example
  not allowed
Purpose:
    orphan continuation
  first line
    continued line
unindented body
`,
      sourcePath: '/project/recovery.sdd',
    }).map((diagnostic) => [
      diagnostic.description,
      diagnostic.lineNumber,
    ])).toEqual([
      [
        'Indentation must use spaces in multiples of 2',
        3,
      ],
      [
        'Invalid SpecDD syntax',
        4,
      ],
      [
        "Section 'Spec' does not support follow-up lines",
        6,
      ],
      [
        'Continuation line must follow a body entry in the same section',
        8,
      ],
      [
        'Body entries must be indented by exactly 2 spaces',
        11,
      ],
    ]);
    expect(parser.validateContent({
      content: '# comment only\n',
      sourcePath: '/project/empty.sdd',
    })).toMatchObject([
      {
        description: 'SpecDD spec must contain a Spec section',
        lineNumber: null,
        sourcePath: '/project/empty.sdd',
      },
    ]);
  });

  it('rethrows unexpected validation failures', () => {
    const parser = createParser();
    const patchedParser = parser as unknown as {
      parseSectionHeader: () => null;
    };

    patchedParser.parseSectionHeader = () => {
      throw new Error('unexpected parser failure');
    };

    expect(() => parser.validateContent({
      content: 'Spec: Example\n',
    })).toThrow('unexpected parser failure');
  });

  it('raises a read error when a spec file cannot be read', async () => {
    const parser = createParser(new MemoryFileSystem({
      readFailure: new Error('permission denied'),
    }));

    await expect(parser.parseFile({
      path: '/project/missing.sdd',
    })).rejects.toBeInstanceOf(SpecParserReadError);
    await expect(parser.validateFile({
      path: '/project/missing.sdd',
    })).rejects.toBeInstanceOf(SpecParserReadError);
  });

  it('requires a Spec section as the first section', () => {
    const parser = createParser();

    expect(() => parser.parseContent({
      content: '# comment only\n',
      sourcePath: '/project/empty.sdd',
    })).toThrow('SpecDD spec must contain a Spec section in /project/empty.sdd.');
    expect(() => parser.parseContent({
      content: 'Purpose:\n  Explain behavior.\n',
    })).toThrow('SpecDD files should start with the Spec section at line 1.');
  });

  it('rejects unknown section labels and missing section separators', () => {
    const parser = createParser();

    expect(() => parser.parseContent({
      content: 'Spec: Example\nPorpose:\n',
    })).toThrow("Unknown SpecDD section 'Porpose' at line 2.");
    expect(() => parser.parseContent({
      content: 'Spec: Example\nPurpose\n',
    })).toThrow("Section 'Purpose' is missing ':' at line 2.");
    expect(() => parser.parseContent({
      content: 'Spec : Example\n',
    })).toThrow("Section 'Spec' is missing ':' at line 1.");
  });

  it('validates inline section value rules', () => {
    const parser = createParser();

    expect(() => parser.parseContent({
      content: 'Spec:Example\n',
    })).toThrow("Inline value for section 'Spec' must be separated from ':' by a space at line 1.");
    expect(() => parser.parseContent({
      content: 'Spec:\n',
    })).toThrow("Section 'Spec' requires an inline value at line 1.");
    expect(() => parser.parseContent({
      content: 'Spec: Example\nPurpose: inline text\n',
    })).toThrow("Section 'Purpose' does not support inline text after ':' at line 2.");
    expect(parser.parseContent({
      content: 'Spec: Example\nExample:   \n',
    }).sectionLookup.Example?.[0]?.inlineValue).toBeNull();
  });

  it('validates repeatability rules', () => {
    const parser = createParser();

    expect(() => parser.parseContent({
      content: `Spec: Example
Purpose:
  One.
Purpose:
  Two.
`,
    })).toThrow(SpecParserDuplicateSectionError);
    expect(() => parser.parseContent({
      content: `Spec: Example
Scenario: same
  Given one
Scenario: same
  Given two
`,
    })).toThrow('Duplicate SpecDD spec section "Scenario: same".');
    expect(parser.parseContent({
      content: `Spec: Example
Scenario: one
  Given one
Scenario: two
  Given two
Example:
  One.
Example:
  Two.
`,
    }).sections.map((section) => section.name)).toEqual([
      'Spec',
      'Scenario',
      'Scenario',
      'Example',
      'Example',
    ]);
  });

  it('rejects body lines under bodyless sections', () => {
    const parser = createParser();

    expect(() => parser.parseContent({
      content: `Spec: Example
  not allowed
`,
    })).toThrow("Section 'Spec' does not support follow-up lines at line 2.");
  });

  it('validates indentation and continuation placement', () => {
    const parser = createParser();

    expect(() => parser.parseContent({
      content: 'Spec: Example\nPurpose:\n\tbad\n',
    })).toThrow('Indentation must use spaces in multiples of 2 at line 3.');
    expect(() => parser.parseContent({
      content: 'Spec: Example\nPurpose:\n   bad\n',
    })).toThrow('Indentation must use spaces in multiples of 2 at line 3.');
    expect(() => parser.parseContent({
      content: 'Spec: Example\nPurpose:\nunindented body\n',
    })).toThrow('Body entries must be indented by exactly 2 spaces at line 3.');
    expect(() => parser.parseContent({
      content: 'Spec: Example\nPurpose:\n    orphan\n',
    })).toThrow('Continuation line must follow a body entry in the same section at line 3.');
    expect(() => parser.parseContent({
      content: 'Spec: Example\n  Purpose:\n',
    })).toThrow('Section headers must start at column 0 at line 2.');
  });

  it('validates Tasks section task syntax', () => {
    const parser = createParser();

    expect(() => parser.parseContent({
      content: 'Spec: Example\nTasks:\n  ordinary text\n',
    })).toThrow('Invalid SpecDD syntax at line 3.');
    expect(() => parser.parseContent({
      content: 'Spec: Example\nTasks:\n  [invalid] #1 Unsupported.\n',
    })).toThrow("Invalid SpecDD task state '[invalid]' at line 3.");
    expect(() => parser.parseContent({
      content: 'Spec: Example\nTasks:\n  [invalid marker\n',
    })).toThrow('Invalid SpecDD syntax at line 3.');
    expect(() => parser.parseContent({
      content: 'Spec: Example\nTasks:\n  [ ] #1\n',
    })).toThrow('Task entries must include task text at line 3.');
    expect(parser.parseContent({
      content: 'Spec: Example\nTasks:\n  [X] # blocked\n',
    }).sectionLookup.Tasks?.[0]?.entries[0]).toEqual({
      kind: 'task',
      lineNumber: 3,
      rawLines: [
        '  [X] # blocked',
      ],
      task: {
        id: null,
        marker: '[X]',
        status: 'done',
        text: '# blocked',
      },
      text: '# blocked',
    });
  });

  it('treats task-looking text outside Tasks as ordinary text', () => {
    const parser = createParser();

    expect(parser.parseContent({
      content: 'Spec: Example\nPurpose:\n  [ ] prose, not a task.\n',
    }).sectionLookup.Purpose?.[0]?.entries[0]).toEqual({
      kind: 'text',
      lineNumber: 3,
      rawLines: [
        '  [ ] prose, not a task.',
      ],
      text: '[ ] prose, not a task.',
    });
  });

  it('parses keyword-only scenario steps and invalid key-value candidates as text', () => {
    const parser = createParser();

    expect(parser.parseContent({
      content: `Spec: Example
Scenario: minimal step
  Given
Purpose:
  : value
  key : value
`,
    }).sectionLookup).toMatchObject({
      Purpose: [
        {
          entries: [
            {
              kind: 'text',
              text: ': value',
            },
            {
              kind: 'text',
              text: 'key : value',
            },
          ],
        },
      ],
      Scenario: [
        {
          entries: [
            {
              kind: 'scenario-step',
              scenarioStep: {
                keyword: 'Given',
                text: '',
              },
              text: 'Given',
            },
          ],
        },
      ],
    });
  });
});
