import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type {
  SpecLintRequest,
  SpecLintResult,
} from '../services/spec-linter/spec-linter.js';
import {
  createLintCommand,
  LintInvalidFormatError,
  renderLintResult,
  resolveLintOutputFormat,
  resolveLintTargetPath,
  type LintCommandContainer,
} from './lint.js';

class FakeSpecLinter {
  public readonly requests: SpecLintRequest[] = [];

  private readonly result: SpecLintResult;

  private readonly failure: Error | null;

  public constructor(result: SpecLintResult = createLintResult(), failure: Error | null = null) {
    this.result = result;
    this.failure = failure;
  }

  public async lint(request: SpecLintRequest): Promise<SpecLintResult> {
    this.requests.push(request);

    if (null !== this.failure) {
      throw this.failure;
    }

    return this.result;
  }
}

const createContainer = (specLinter: FakeSpecLinter): LintCommandContainer => {
  return {
    specLinter,
  };
};

const createLintResult = (): SpecLintResult => {
  const syntaxDiagnostic = {
    code: 'syntax',
    lineNumber: 3,
    message: 'Body entries must be indented by exactly 2 spaces',
    path: 'billing/billing.sdd',
    severity: 'error' as const,
  };
  const directoryDiagnostic = {
    code: 'directory-spec',
    message: 'Ambiguous directory-level SpecDD specs for billing: billing/BILLING.sdd, billing/billing.sdd',
    path: 'billing/billing.sdd',
    severity: 'error' as const,
  };

  return {
    diagnostics: [
      syntaxDiagnostic,
      directoryDiagnostic,
    ],
    errorCount: 2,
    filesChecked: 2,
    ok: false,
    root: {
      children: [
        {
          diagnostics: [],
          directoryLevel: false,
          name: 'app.sdd',
          path: 'app.sdd',
          type: 'spec',
        },
        {
          children: [],
          name: 'billing',
          path: 'billing',
          spec: {
            diagnostics: [
              syntaxDiagnostic,
              directoryDiagnostic,
            ],
            directoryLevel: true,
            name: 'billing.sdd',
            path: 'billing/billing.sdd',
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
    targetDirectoryPath: '/project',
    warningCount: 0,
  };
};

const createCleanLintResult = (): SpecLintResult => {
  return {
    diagnostics: [],
    errorCount: 0,
    filesChecked: 1,
    ok: true,
    root: {
      children: [
        {
          diagnostics: [],
          directoryLevel: false,
          name: 'app.sdd',
          path: 'app.sdd',
          type: 'spec',
        },
      ],
      name: 'project',
      path: '.',
      spec: null,
      type: 'directory',
    },
    targetDirectoryPath: '/project',
    warningCount: 0,
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

describe('lint command', () => {
  it('defines concise help text', () => {
    const specLinter = new FakeSpecLinter();
    const command = createLintCommand(createContainer(specLinter), () => '/project');
    const pathArgument = command.registeredArguments[0];
    const formatOption = command.options.find((option) => '--format' === option.long);
    const help = renderHelp(command);

    expect(command.description()).toBe('Lint SpecDD spec files.');
    expect(pathArgument?.description).toBe('Directory to lint. Defaults to the current directory.');
    expect(formatOption?.description).toBe('Output format: text or json.');
    expect(formatOption?.defaultValue).toBe('text');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
  });

  it('resolves target paths', () => {
    expect(resolveLintTargetPath('/project', undefined)).toBe('/project');
    expect(resolveLintTargetPath('/project', 'src')).toBe('/project/src');
    expect(resolveLintTargetPath('/project', '/other')).toBe('/other');
  });

  it('resolves and rejects output formats', () => {
    expect(resolveLintOutputFormat('text')).toBe('text');
    expect(resolveLintOutputFormat('json')).toBe('json');
    expect(() => resolveLintOutputFormat('yaml')).toThrow(LintInvalidFormatError);
  });

  it('renders human-readable diagnostics grouped by file path', () => {
    expect(renderLintResult(createLintResult(), 'text')).toBe(`billing/billing.sdd:
  - Syntax error, line 3: Body entries must be indented by exactly 2 spaces
  - Directory spec error: Ambiguous directory-level SpecDD specs for billing: billing/BILLING.sdd, billing/billing.sdd

2 errors, 0 warnings in 2 specs
`);
  });

  it('renders warning diagnostics with the same text format', () => {
    const warningDiagnostic = {
      code: 'style',
      message: 'Purpose section is recommended',
      path: 'app.sdd',
      severity: 'warning' as const,
    };

    expect(renderLintResult({
      ...createCleanLintResult(),
      diagnostics: [
        warningDiagnostic,
      ],
      warningCount: 1,
    }, 'text')).toBe(`app.sdd:
  - Style warning: Purpose section is recommended

0 errors, 1 warning in 1 spec
`);
  });

  it('renders compact JSON for machine consumers', () => {
    expect(JSON.parse(renderLintResult(createLintResult(), 'json'))).toEqual({
      directories: [
        {
          path: '/',
          specs: [
            {
              diagnostics: [],
              directoryLevel: false,
              name: 'app.sdd',
              path: 'app.sdd',
            },
          ],
        },
        {
          path: '/billing/',
          specs: [
            {
              diagnostics: [
                {
                  code: 'syntax',
                  lineNumber: 3,
                  message: 'Body entries must be indented by exactly 2 spaces',
                  path: 'billing/billing.sdd',
                  severity: 'error',
                },
                {
                  code: 'directory-spec',
                  message: 'Ambiguous directory-level SpecDD specs for billing: billing/BILLING.sdd, billing/billing.sdd',
                  path: 'billing/billing.sdd',
                  severity: 'error',
                },
              ],
              directoryLevel: true,
              name: 'billing.sdd',
              path: 'billing/billing.sdd',
            },
          ],
        },
      ],
      errorCount: 2,
      filesChecked: 2,
      ok: false,
      targetDirectoryPath: '/project',
      warningCount: 0,
    });
  });

  it('omits clean files from text output', () => {
    const result: SpecLintResult = {
      ...createCleanLintResult(),
      root: {
        children: [
          {
            children: [
              {
                children: [
                  {
                    diagnostics: [],
                    directoryLevel: false,
                    name: 'feature.sdd',
                    path: 'parent/child/feature.sdd',
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
        name: 'project',
        path: '.',
        spec: null,
        type: 'directory',
      },
    };
    const text = renderLintResult(result, 'text');
    const compactJson = JSON.parse(renderLintResult(result, 'json'));

    expect(text).toBe('0 errors, 0 warnings in 1 spec\n');
    expect(compactJson.directories.map((directory: { path: string }) => directory.path)).not.toContain('/parent/');
    expect(compactJson.directories.map((directory: { path: string }) => directory.path)).toContain('/parent/child/');
  });

  it('rejects unsupported render formats', () => {
    expect(() => renderLintResult(createLintResult(), 'yaml')).toThrow(LintInvalidFormatError);
  });

  it('calls spec linter with the current working directory and writes text by default', async () => {
    const specLinter = new FakeSpecLinter();
    const output: string[] = [];
    const exitCodes: number[] = [];
    const command = createLintCommand(createContainer(specLinter), () => '/project', (message) => {
      output.push(message);
    }, (exitCode) => {
      exitCodes.push(exitCode);
    });

    await command.parseAsync([], {
      from: 'user',
    });

    expect(specLinter.requests).toEqual([
      {
        targetDirectoryPath: '/project',
      },
    ]);
    expect(output.join('')).toContain('2 errors, 0 warnings in 2 specs');
    expect(exitCodes).toEqual([
      1,
    ]);
  });

  it('calls spec linter with a resolved target path and JSON output', async () => {
    const specLinter = new FakeSpecLinter();
    const output: string[] = [];
    const exitCodes: number[] = [];
    const command = createLintCommand(createContainer(specLinter), () => '/project', (message) => {
      output.push(message);
    }, (exitCode) => {
      exitCodes.push(exitCode);
    });

    await command.parseAsync([
      'src',
      '--format',
      'json',
    ], {
      from: 'user',
    });

    expect(specLinter.requests).toEqual([
      {
        targetDirectoryPath: '/project/src',
      },
    ]);
    expect(JSON.parse(output.join('')).ok).toBe(false);
    expect(exitCodes).toEqual([
      1,
    ]);
  });

  it('does not set a failure exit code for clean lint results', async () => {
    const specLinter = new FakeSpecLinter(createCleanLintResult());
    const exitCodes: number[] = [];
    const command = createLintCommand(createContainer(specLinter), () => '/project', () => undefined, (exitCode) => {
      exitCodes.push(exitCode);
    });

    await command.parseAsync([], {
      from: 'user',
    });

    expect(exitCodes).toEqual([]);
  });

  it('uses process cwd and stdout when providers are omitted', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const specLinter = new FakeSpecLinter(createCleanLintResult());
    const command = createLintCommand(createContainer(specLinter));

    try {
      await command.parseAsync([], {
        from: 'user',
      });

      expect(stdoutWrite).toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
      stdoutWrite.mockRestore();
    }

    expect(specLinter.requests).toEqual([
      {
        targetDirectoryPath: '/project',
      },
    ]);
  });

  it('uses the default process exit code setter when lint fails', async () => {
    const previousExitCode = process.exitCode;
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const specLinter = new FakeSpecLinter();
    const command = createLintCommand(createContainer(specLinter), () => '/project');

    try {
      await command.parseAsync([], {
        from: 'user',
      });

      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      stdoutWrite.mockRestore();
    }
  });

  it('rejects invalid formats before linting', async () => {
    const specLinter = new FakeSpecLinter();
    const command = createLintCommand(createContainer(specLinter), () => '/project');

    await expect(command.parseAsync([
      '--format',
      'yaml',
    ], {
      from: 'user',
    })).rejects.toBeInstanceOf(LintInvalidFormatError);
    expect(specLinter.requests).toEqual([]);
  });

  it('propagates spec linter failures', async () => {
    const failure = new Error('lint failed');
    const specLinter = new FakeSpecLinter(undefined, failure);
    const command = createLintCommand(createContainer(specLinter), () => '/project');

    await expect(command.parseAsync([], {
      from: 'user',
    })).rejects.toBe(failure);
  });
});
