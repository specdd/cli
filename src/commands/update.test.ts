import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { DistributionInstallResult } from '../services/distribution-installer/distribution-installer.js';
import { createUpdateCommand, type UpdateCommandContainer } from './update.js';

class FakeDistributionInstaller {
  public readonly requests: Array<{ currentWorkingDirectoryPath: string; version: string }> = [];

  private readonly failure: Error | null;

  public constructor(failure: Error | null = null) {
    this.failure = failure;
  }

  public async update(request: {
    currentWorkingDirectoryPath: string;
    version: string;
  }): Promise<DistributionInstallResult> {
    this.requests.push(request);

    if (null !== this.failure) {
      throw this.failure;
    }

    return {
      applyResult: {
        overwrittenPaths: [],
        skippedPaths: [],
        writtenPaths: [],
      },
      signerFingerprint: 'fd87313256e08c486951f9091372d38569116bc5',
      updated: true,
      version: '1.2.3',
    };
  }
}

const createContainer = (installer: FakeDistributionInstaller): UpdateCommandContainer => {
  return {
    distributionInstaller: installer,
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

describe('update command', () => {
  it('defines concise help text', () => {
    const installer = new FakeDistributionInstaller();
    const command = createUpdateCommand(createContainer(installer), () => '/project');
    const versionOption = command.options.find((option) => '--version' === option.long);
    const help = renderHelp(command);

    expect(command.description()).toBe('Update SpecDD files in the current project.');
    expect(versionOption?.description).toBe('SpecDD release version to install. Defaults to latest.');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
  });

  it('calls installer update with the current working directory and latest by default', async () => {
    const installer = new FakeDistributionInstaller();
    const command = createUpdateCommand(createContainer(installer), () => '/project');

    await command.parseAsync([], {
      from: 'user',
    });

    expect(installer.requests).toEqual([
      {
        currentWorkingDirectoryPath: '/project',
        version: 'latest',
      },
    ]);
  });

  it('uses process cwd when no current working directory provider is given', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const installer = new FakeDistributionInstaller();
    const command = createUpdateCommand(createContainer(installer));

    try {
      await command.parseAsync([], {
        from: 'user',
      });
    } finally {
      cwd.mockRestore();
    }

    expect(installer.requests).toEqual([
      {
        currentWorkingDirectoryPath: '/project',
        version: 'latest',
      },
    ]);
  });

  it('calls installer update with an explicit release version', async () => {
    const installer = new FakeDistributionInstaller();
    const command = createUpdateCommand(createContainer(installer), () => '/project');

    await command.parseAsync([
      '--version',
      '1.2.3',
    ], {
      from: 'user',
    });

    expect(installer.requests).toEqual([
      {
        currentWorkingDirectoryPath: '/project',
        version: '1.2.3',
      },
    ]);
  });

  it('propagates installer errors', async () => {
    const failure = new Error('install failed');
    const installer = new FakeDistributionInstaller(failure);
    const command = createUpdateCommand(createContainer(installer), () => '/project');

    await expect(command.parseAsync([], {
      from: 'user',
    })).rejects.toBe(failure);
  });
});
