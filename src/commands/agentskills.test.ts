import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { AgentSkillsDeployResult } from '../services/agentskills/agentskills.js';
import {
  AgentSkillsDeployTargetConflictError,
  createAgentSkillsCommand,
  resolveAgentSkillsDeployTargetPath,
  type AgentSkillsCommandContainer,
} from './agentskills.js';

class FakeAgentSkills {
  public readonly requests: Array<{ targetDirectoryPath: string; version: string }> = [];

  private readonly failure: Error | null;

  public constructor(failure: Error | null = null) {
    this.failure = failure;
  }

  public async deploy(request: { targetDirectoryPath: string; version: string }): Promise<AgentSkillsDeployResult> {
    this.requests.push(request);

    if (null !== this.failure) {
      throw this.failure;
    }

    return {
      applyResult: {
        ignoredReleasePaths: [],
        installedSkillNames: [
          'specdd-example',
        ],
        overwrittenPaths: [],
        writtenPaths: [
          `${request.targetDirectoryPath}/.agents/skills/specdd-example/SKILL.md`,
        ],
      },
      installDirectoryPath: `${request.targetDirectoryPath}/.agents/skills`,
      signerFingerprint: 'fd87313256e08c486951f9091372d38569116bc5',
      version: 'v1.2.3',
    };
  }
}

const createContainer = (agentSkills: FakeAgentSkills): AgentSkillsCommandContainer => {
  return {
    agentSkills,
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

describe('agentskills command', () => {
  it('defines concise help text', () => {
    const agentSkills = new FakeAgentSkills();
    const command = createAgentSkillsCommand(createContainer(agentSkills), () => '/project', () => '/home/user');
    const deployCommand = command.commands.find((childCommand) => 'deploy' === childCommand.name());
    const pathArgument = deployCommand?.registeredArguments[0];
    const userOption = deployCommand?.options.find((option) => '--user' === option.long);
    const versionOption = deployCommand?.options.find((option) => '--version' === option.long);
    const help = renderHelp(command);
    const deployHelp = renderHelp(deployCommand!);

    expect(command.description()).toBe('Manage SpecDD Agent Skills.');
    expect(deployCommand?.description()).toBe('Deploy SpecDD Agent Skills into a user or project skills directory.');
    expect(pathArgument?.description).toBe('Project directory to install into. Defaults to the current directory.');
    expect(userOption?.description).toBe('Install into the current user home Agent Skills directory.');
    expect(versionOption?.description).toBe('Agent Skills release tag to install. Defaults to latest.');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(deployHelp).toContain('Spec help: https://specdd.ai');
    expect(deployHelp).toContain('CLI help: https://github.com/specdd/cli');
  });

  it('resolves a missing target path to the current working directory', () => {
    expect(resolveAgentSkillsDeployTargetPath('/project', '/home/user', undefined, false)).toBe('/project');
  });

  it('resolves a relative target path against the current working directory', () => {
    expect(resolveAgentSkillsDeployTargetPath('/project', '/home/user', 'packages/app', false)).toBe(
      '/project/packages/app',
    );
  });

  it('passes an absolute target path through as the target directory', () => {
    expect(resolveAgentSkillsDeployTargetPath('/project', '/home/user', '/other/project', false)).toBe(
      '/other/project',
    );
  });

  it('resolves user-home deploys to the home directory', () => {
    expect(resolveAgentSkillsDeployTargetPath('/project', '/home/user', undefined, true)).toBe('/home/user');
  });

  it('rejects user-home deploys with an explicit path', () => {
    expect(() => resolveAgentSkillsDeployTargetPath('/project', '/home/user', 'packages/app', true)).toThrow(
      AgentSkillsDeployTargetConflictError,
    );
  });

  it('calls agent skills deploy with the current working directory by default', async () => {
    const agentSkills = new FakeAgentSkills();
    const command = createAgentSkillsCommand(createContainer(agentSkills), () => '/project', () => '/home/user');

    await command.parseAsync([
      'deploy',
    ], {
      from: 'user',
    });

    expect(agentSkills.requests).toEqual([
      {
        targetDirectoryPath: '/project',
        version: 'latest',
      },
    ]);
  });

  it('uses process cwd and home directory when no providers are given', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const agentSkills = new FakeAgentSkills();
    const command = createAgentSkillsCommand(createContainer(agentSkills));

    try {
      await command.parseAsync([
        'deploy',
      ], {
        from: 'user',
      });
    } finally {
      cwd.mockRestore();
    }

    expect(agentSkills.requests).toEqual([
      {
        targetDirectoryPath: '/project',
        version: 'latest',
      },
    ]);
  });

  it('calls agent skills deploy with a resolved relative target path', async () => {
    const agentSkills = new FakeAgentSkills();
    const command = createAgentSkillsCommand(createContainer(agentSkills), () => '/project', () => '/home/user');

    await command.parseAsync([
      'deploy',
      'packages/app',
    ], {
      from: 'user',
    });

    expect(agentSkills.requests).toEqual([
      {
        targetDirectoryPath: '/project/packages/app',
        version: 'latest',
      },
    ]);
  });

  it('calls agent skills deploy with a user-home target and explicit release version', async () => {
    const agentSkills = new FakeAgentSkills();
    const command = createAgentSkillsCommand(createContainer(agentSkills), () => '/project', () => '/home/user');

    await command.parseAsync([
      'deploy',
      '--user',
      '--version',
      'v1.2.3',
    ], {
      from: 'user',
    });

    expect(agentSkills.requests).toEqual([
      {
        targetDirectoryPath: '/home/user',
        version: 'v1.2.3',
      },
    ]);
  });

  it('propagates agent skills deploy errors', async () => {
    const failure = new Error('deploy failed');
    const agentSkills = new FakeAgentSkills(failure);
    const command = createAgentSkillsCommand(createContainer(agentSkills), () => '/project', () => '/home/user');

    await expect(command.parseAsync([
      'deploy',
    ], {
      from: 'user',
    })).rejects.toBe(failure);
  });
});
