import { jest } from '@jest/globals';
import { Command, CommanderError } from 'commander';
import { CliError } from './cli-error.js';
import { Main, type MainSelfRunRequest } from './main.js';

const createCommand = (name: string, calls: string[]): Command => {
  return new Command(name).action(() => {
    calls.push(name);
  });
};

class FakeLogger {
  public readonly errors: string[] = [];

  public error(message: string): void {
    this.errors.push(message);
  }
}

class ExpectedTestCliError extends CliError {
  public constructor() {
    super('SpecDD target is already initialized: /project');
    this.name = 'ExpectedTestCliError';
  }
}

const createContainer = (calls: string[] = [], logger: FakeLogger = new FakeLogger()) => {
  return {
    agentSkillsCommand: createCommand('agentskills', calls),
    checkUpdateCommand: createCommand('check-update', calls),
    initCommand: createCommand('init', calls),
    inspectCommand: createCommand('inspect', calls),
    logger,
    lintCommand: createCommand('lint', calls),
    resolveCommand: createCommand('resolve', calls),
    updateCommand: createCommand('update', calls),
  };
};

const createMain = (calls: string[] = []): Main => {
  return new Main(createContainer(calls));
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

const createSelfRunRequest = (
  override: Partial<MainSelfRunRequest> = {},
): MainSelfRunRequest => {
  const calls: string[] = [];

  return {
    argv: [
      'node',
      '/project/dist/main.js',
      'unknown',
    ],
    container: createContainer(calls),
    entrypointPath: '/project/dist/main.js',
    environment: {},
    realPath: async (path: string) => path,
    modulePath: '/project/dist/main.js',
    ...override,
  };
};

describe('Main', () => {
  it('builds the root specdd command with container command instances', () => {
    const main = createMain();
    const command = main.createCommand();
    const help = renderHelp(command);

    expect(command.name()).toBe('specdd');
    expect(command.description()).toBe('Work with SpecDD framework files in a project.');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
    expect(command.commands.map((childCommand) => childCommand.name())).toEqual([
      'agentskills',
      'check-update',
      'init',
      'inspect',
      'lint',
      'resolve',
      'update',
    ]);
  });

  it('parses argv values and dispatches the init command', async () => {
    const calls: string[] = [];
    const main = createMain(calls);

    await main.run([
      'node',
      '/project/dist/main.js',
      'init',
    ]);

    expect(calls).toEqual([
      'init',
    ]);
  });

  it('parses argv values and dispatches the agentskills command', async () => {
    const calls: string[] = [];
    const main = createMain(calls);

    await main.run([
      'node',
      '/project/dist/main.js',
      'agentskills',
    ]);

    expect(calls).toEqual([
      'agentskills',
    ]);
  });

  it('parses argv values and dispatches the check-update command', async () => {
    const calls: string[] = [];
    const main = createMain(calls);

    await main.run([
      'node',
      '/project/dist/main.js',
      'check-update',
    ]);

    expect(calls).toEqual([
      'check-update',
    ]);
  });

  it('parses argv values and dispatches the update command', async () => {
    const calls: string[] = [];
    const main = createMain(calls);

    await main.run([
      'node',
      '/project/dist/main.js',
      'update',
    ]);

    expect(calls).toEqual([
      'update',
    ]);
  });

  it('parses argv values and dispatches the lint command', async () => {
    const calls: string[] = [];
    const main = createMain(calls);

    await main.run([
      'node',
      '/project/dist/main.js',
      'lint',
    ]);

    expect(calls).toEqual([
      'lint',
    ]);
  });

  it('parses argv values and dispatches the resolve command', async () => {
    const calls: string[] = [];
    const main = createMain(calls);

    await main.run([
      'node',
      '/project/dist/main.js',
      'resolve',
    ]);

    expect(calls).toEqual([
      'resolve',
    ]);
  });

  it('parses argv values and dispatches the inspect command', async () => {
    const calls: string[] = [];
    const main = createMain(calls);

    await main.run([
      'node',
      '/project/dist/main.js',
      'inspect',
    ]);

    expect(calls).toEqual([
      'inspect',
    ]);
  });

  it('returns after Commander displays help without exiting the process', async () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const main = createMain();

    try {
      await expect(main.run([
        'node',
        '/project/dist/main.js',
        '--help',
      ])).resolves.toBeUndefined();
    } finally {
      stdoutWrite.mockRestore();
    }
  });

  it('raises Commander errors instead of exiting the process', async () => {
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const main = createMain();

    try {
      await expect(main.run([
        'node',
        '/project/dist/main.js',
        'missing',
      ])).rejects.toBeInstanceOf(CommanderError);
    } finally {
      stderrWrite.mockRestore();
    }
  });

  it('does not self-run when NODE_ENV is test', async () => {
    await expect(Main.selfRun(createSelfRunRequest({
      environment: {
        NODE_ENV: 'test',
      },
    }))).resolves.toBeUndefined();
  });

  it('does not self-run when Jest is running', async () => {
    await expect(Main.selfRun(createSelfRunRequest({
      environment: {
        JEST_WORKER_ID: '1',
      },
    }))).resolves.toBeUndefined();
  });

  it('does not self-run without an entrypoint path', async () => {
    await expect(Main.selfRun(createSelfRunRequest({
      entrypointPath: undefined,
    }))).resolves.toBeUndefined();
  });

  it('does not self-run when loaded as a non-entrypoint module', async () => {
    await expect(Main.selfRun(createSelfRunRequest({
      entrypointPath: '/project/dist/other.js',
    }))).resolves.toBeUndefined();
  });

  it('self-runs when loaded as the process entrypoint outside test execution', async () => {
    const calls: string[] = [];

    await expect(Main.selfRun(createSelfRunRequest({
      argv: [
        'node',
        '/project/dist/main.js',
        'init',
      ],
      container: createContainer(calls),
    }))).resolves.toBeUndefined();

    expect(calls).toEqual([
      'init',
    ]);
  });

  it('self-runs when a package-bin symlink resolves to the module path', async () => {
    const calls: string[] = [];

    await expect(Main.selfRun(createSelfRunRequest({
      argv: [
        'node',
        '/usr/local/bin/specdd',
        'update',
      ],
      container: createContainer(calls),
      entrypointPath: '/usr/local/bin/specdd',
      modulePath: '/project/dist/main.js',
      realPath: async (path: string) => {
        if ('/usr/local/bin/specdd' === path) {
          return '/project/dist/main.js';
        }

        return path;
      },
    }))).resolves.toBeUndefined();

    expect(calls).toEqual([
      'update',
    ]);
  });

  it('uses injected exit for command failures while self-running', async () => {
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitCodes: number[] = [];

    try {
      await expect(Main.selfRun(createSelfRunRequest({
        exit: (exitCode: number): void => {
          exitCodes.push(exitCode);
        },
      }))).resolves.toBeUndefined();
    } finally {
      stderrWrite.mockRestore();
    }

    expect(exitCodes).toEqual([
      1,
    ]);
  });

  it('logs expected CLI errors and exits without rethrowing', async () => {
    const logger = new FakeLogger();
    const exitCodes: number[] = [];

    await expect(Main.selfRun(createSelfRunRequest({
      argv: [
        'node',
        '/project/dist/main.js',
        'init',
      ],
      container: {
        agentSkillsCommand: createCommand('agentskills', []),
        checkUpdateCommand: createCommand('check-update', []),
        initCommand: new Command('init').action(() => {
          throw new ExpectedTestCliError();
        }),
        inspectCommand: createCommand('inspect', []),
        logger,
        lintCommand: createCommand('lint', []),
        resolveCommand: createCommand('resolve', []),
        updateCommand: createCommand('update', []),
      },
      exit: (exitCode: number): void => {
        exitCodes.push(exitCode);
      },
    }))).resolves.toBeUndefined();

    expect(logger.errors).toEqual([
      'SpecDD target is already initialized: /project',
    ]);
    expect(exitCodes).toEqual([
      1,
    ]);
  });

  it('writes expected CLI errors to stderr when the logger is unavailable', async () => {
    const originalLogLevel = process.env.SPECDD_LOG_LEVEL;
    const stderrMessages: string[] = [];
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation((message) => {
      stderrMessages.push(String(message));

      return true;
    });
    const exitCodes: number[] = [];
    const request = createSelfRunRequest({
      argv: [
        'node',
        '/project/dist/main.js',
        '--help',
      ],
      exit: (exitCode: number): void => {
        exitCodes.push(exitCode);
      },
    });
    const {
      container: _container,
      ...requestWithoutContainer
    } = request;

    process.env.SPECDD_LOG_LEVEL = 'invalid';

    try {
      await expect(Main.selfRun(requestWithoutContainer)).resolves.toBeUndefined();
    } finally {
      if (undefined === originalLogLevel) {
        delete process.env.SPECDD_LOG_LEVEL;
      } else {
        process.env.SPECDD_LOG_LEVEL = originalLogLevel;
      }

      stderrWrite.mockRestore();
    }

    expect(stderrMessages).toEqual([
      '[error] Invalid log_level config value: invalid\n',
    ]);
    expect(exitCodes).toEqual([
      1,
    ]);
  });

  it('still exits when fallback stderr writing fails for an expected CLI error', async () => {
    const originalLogLevel = process.env.SPECDD_LOG_LEVEL;
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr failed');
    });
    const exitCodes: number[] = [];
    const request = createSelfRunRequest({
      argv: [
        'node',
        '/project/dist/main.js',
        '--help',
      ],
      exit: (exitCode: number): void => {
        exitCodes.push(exitCode);
      },
    });
    const {
      container: _container,
      ...requestWithoutContainer
    } = request;

    process.env.SPECDD_LOG_LEVEL = 'invalid';

    try {
      await expect(Main.selfRun(requestWithoutContainer)).resolves.toBeUndefined();
    } finally {
      if (undefined === originalLogLevel) {
        delete process.env.SPECDD_LOG_LEVEL;
      } else {
        process.env.SPECDD_LOG_LEVEL = originalLogLevel;
      }

      stderrWrite.mockRestore();
    }

    expect(exitCodes).toEqual([
      1,
    ]);
  });

  it('rethrows non-Commander failures while self-running', async () => {
    const failure = new Error('command failed');

    await expect(Main.selfRun(createSelfRunRequest({
      argv: [
        'node',
        '/project/dist/main.js',
        'init',
      ],
      container: {
        agentSkillsCommand: createCommand('agentskills', []),
        checkUpdateCommand: createCommand('check-update', []),
        initCommand: new Command('init').action(() => {
          throw failure;
        }),
        inspectCommand: createCommand('inspect', []),
        logger: new FakeLogger(),
        lintCommand: createCommand('lint', []),
        resolveCommand: createCommand('resolve', []),
        updateCommand: createCommand('update', []),
      },
    }))).rejects.toBe(failure);
  });

  it('constructs the default container when self-running without an injected container', async () => {
    const stdoutWrite = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const request = createSelfRunRequest({
      argv: [
        'node',
        '/project/dist/main.js',
        '--help',
      ],
    });
    const {
      container: _container,
      ...requestWithoutContainer
    } = request;

    try {
      await expect(Main.selfRun(requestWithoutContainer)).resolves.toBeUndefined();
    } finally {
      stdoutWrite.mockRestore();
    }
  });
});
