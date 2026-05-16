import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { DistributionInstallResult } from '../services/distribution-installer/distribution-installer.js';
import { createInitCommand, resolveInitTargetPath, type InitCommandContainer } from './init.js';

class FakeDistributionInstaller {
  public readonly requests: Array<{ targetDirectoryPath: string; version: string }> = [];

  private readonly failure: Error | null;

  public constructor(failure: Error | null = null) {
    this.failure = failure;
  }

  public async init(request: { targetDirectoryPath: string; version: string }): Promise<DistributionInstallResult> {
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

const createContainer = (installer: FakeDistributionInstaller): InitCommandContainer => {
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

describe('init command', () => {
  it('defines concise help text', () => {
    const installer = new FakeDistributionInstaller();
    const command = createInitCommand(createContainer(installer), () => '/project');
    const pathArgument = command.registeredArguments[0];
    const versionOption = command.options.find((option) => '--version' === option.long);
    const help = renderHelp(command);

    expect(command.description()).toBe('Initialize SpecDD in the current directory or a target directory.');
    expect(pathArgument?.description).toBe('Directory to initialize. Defaults to the current directory.');
    expect(versionOption?.description).toBe('SpecDD release version to install. Defaults to latest.');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
  });

  it('resolves a missing target path to the current working directory', () => {
    expect(resolveInitTargetPath('/project', undefined)).toBe('/project');
  });

  it('resolves a relative target path against the current working directory', () => {
    expect(resolveInitTargetPath('/project', 'packages/app')).toBe('/project/packages/app');
  });

  it('passes an absolute target path through as the target directory', () => {
    expect(resolveInitTargetPath('/project', '/other/project')).toBe('/other/project');
  });

  it('calls installer init with the current working directory by default', async () => {
    const installer = new FakeDistributionInstaller();
    const command = createInitCommand(createContainer(installer), () => '/project');

    await command.parseAsync([], {
      from: 'user',
    });

    expect(installer.requests).toEqual([
      {
        targetDirectoryPath: '/project',
        version: 'latest',
      },
    ]);
  });

  it('uses process cwd when no current working directory provider is given', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const installer = new FakeDistributionInstaller();
    const command = createInitCommand(createContainer(installer));

    try {
      await command.parseAsync([], {
        from: 'user',
      });
    } finally {
      cwd.mockRestore();
    }

    expect(installer.requests).toEqual([
      {
        targetDirectoryPath: '/project',
        version: 'latest',
      },
    ]);
  });

  it('calls installer init with a resolved relative target path', async () => {
    const installer = new FakeDistributionInstaller();
    const command = createInitCommand(createContainer(installer), () => '/project');

    await command.parseAsync([
      'packages/app',
    ], {
      from: 'user',
    });

    expect(installer.requests).toEqual([
      {
        targetDirectoryPath: '/project/packages/app',
        version: 'latest',
      },
    ]);
  });

  it('calls installer init with an absolute target path and explicit release version', async () => {
    const installer = new FakeDistributionInstaller();
    const command = createInitCommand(createContainer(installer), () => '/project');

    await command.parseAsync([
      '/other/project',
      '--version',
      '1.2.3',
    ], {
      from: 'user',
    });

    expect(installer.requests).toEqual([
      {
        targetDirectoryPath: '/other/project',
        version: '1.2.3',
      },
    ]);
  });

  it('propagates installer errors', async () => {
    const failure = new Error('install failed');
    const installer = new FakeDistributionInstaller(failure);
    const command = createInitCommand(createContainer(installer), () => '/project');

    await expect(command.parseAsync([], {
      from: 'user',
    })).rejects.toBe(failure);
  });
});
