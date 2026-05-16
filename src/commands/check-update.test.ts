import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { UpdateCheckResult } from '../services/update-checker/update-checker.js';
import { createCheckUpdateCommand, type CheckUpdateCommandContainer } from './check-update.js';

class FakeUpdateChecker {
  public readonly requests: Array<{ currentWorkingDirectoryPath: string }> = [];

  private readonly result: UpdateCheckResult;

  private readonly failure: Error | null;

  public constructor(result: UpdateCheckResult = {
    latestVersion: '1.2.3',
    localVersion: '1.2.3',
    updateAvailable: false,
  }, failure: Error | null = null) {
    this.result = result;
    this.failure = failure;
  }

  public async check(request: { currentWorkingDirectoryPath: string }): Promise<UpdateCheckResult> {
    this.requests.push(request);

    if (null !== this.failure) {
      throw this.failure;
    }

    return this.result;
  }
}

const createContainer = (updateChecker: FakeUpdateChecker): CheckUpdateCommandContainer => {
  return {
    updateChecker,
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

describe('check-update command', () => {
  it('defines concise help text', () => {
    const updateChecker = new FakeUpdateChecker();
    const command = createCheckUpdateCommand(createContainer(updateChecker), () => '/project');
    const help = renderHelp(command);

    expect(command.description()).toBe('Check whether a newer SpecDD release is available for the current project.');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
  });

  it('calls update checker with the current working directory', async () => {
    const updateChecker = new FakeUpdateChecker();
    const exitCodes: number[] = [];
    const command = createCheckUpdateCommand(
      createContainer(updateChecker),
      () => '/project',
      (exitCode) => {
        exitCodes.push(exitCode);
      },
    );

    await command.parseAsync([], {
      from: 'user',
    });

    expect(updateChecker.requests).toEqual([
      {
        currentWorkingDirectoryPath: '/project',
      },
    ]);
    expect(exitCodes).toEqual([
      0,
    ]);
  });

  it('uses process cwd when no current working directory provider is given', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const updateChecker = new FakeUpdateChecker();
    const exitCodes: number[] = [];
    const command = createCheckUpdateCommand(
      createContainer(updateChecker),
      undefined,
      (exitCode) => {
        exitCodes.push(exitCode);
      },
    );

    try {
      await command.parseAsync([], {
        from: 'user',
      });
    } finally {
      cwd.mockRestore();
    }

    expect(updateChecker.requests).toEqual([
      {
        currentWorkingDirectoryPath: '/project',
      },
    ]);
    expect(exitCodes).toEqual([
      0,
    ]);
  });

  it('sets process exit code when no exit code setter is given', async () => {
    const originalExitCode = process.exitCode;
    const updateChecker = new FakeUpdateChecker({
      latestVersion: '1.2.3',
      localVersion: '1.2.2',
      updateAvailable: true,
    });
    const command = createCheckUpdateCommand(createContainer(updateChecker), () => '/project');

    try {
      await command.parseAsync([], {
        from: 'user',
      });

      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it('sets exit code 1 when an update is available', async () => {
    const updateChecker = new FakeUpdateChecker({
      latestVersion: '1.2.3',
      localVersion: '1.2.2',
      updateAvailable: true,
    });
    const exitCodes: number[] = [];
    const command = createCheckUpdateCommand(
      createContainer(updateChecker),
      () => '/project',
      (exitCode) => {
        exitCodes.push(exitCode);
      },
    );

    await command.parseAsync([], {
      from: 'user',
    });

    expect(exitCodes).toEqual([
      1,
    ]);
  });

  it('propagates update checker errors', async () => {
    const failure = new Error('check failed');
    const updateChecker = new FakeUpdateChecker(undefined, failure);
    const command = createCheckUpdateCommand(createContainer(updateChecker), () => '/project');

    await expect(command.parseAsync([], {
      from: 'user',
    })).rejects.toBe(failure);
  });
});
