import { jest } from '@jest/globals';
import type { PluginUpdater } from '../../services/plugin-updater/plugin-updater.js';
import { createPluginUpdateCommand } from './update.js';

describe('plugin update command', () => {
  const update = jest.fn<PluginUpdater['update']>();
  const makeCommand = () => createPluginUpdateCommand({ pluginUpdater: { update, }, }, () => '/project/nested/..')
    .exitOverride().configureOutput({ writeErr: () => {}, });

  beforeEach(() => { update.mockReset(); });

  it.each([
    { args: [], repository: undefined, pluginName: undefined, version: undefined, },
    { args: ['@acme/repo', 'review',], repository: '@acme/repo', pluginName: 'review', version: undefined, },
    { args: ['@acme/repo', 'review', 'v2.0.0',], repository: '@acme/repo', pluginName: 'review', version: 'v2.0.0', },
    { args: ['@acme/repo', 'review', 'latest',], repository: '@acme/repo', pluginName: 'review', version: 'latest', },
    { args: ['git@github.com:acme/repo.git', 'review', 'abc1234',], repository: 'git@github.com:acme/repo.git', pluginName: 'review', version: 'abc1234', },
    { args: ['https://github.com/acme/repo.git', 'review', 'refs/heads/main',], repository: 'https://github.com/acme/repo.git', pluginName: 'review', version: 'refs/heads/main', },
  ])('forwards optional arguments $args', async ({ args, repository, pluginName, version }) => {
    await makeCommand().parseAsync(args, { from: 'user', });
    expect(update).toHaveBeenCalledWith({ targetDirectoryPath: '/project', repository, pluginName, version, });
  });

  it.each([
    { args: ['@acme/repo', 'review', 'v2', 'extra',], },
    { args: ['review',], },
    { args: ['@acme/repo',], },
    { args: ['--version', 'v2',], },
    { args: ['--unknown',], },
  ])('rejects invalid arguments $args before invoking the service', async ({ args }) => {
    await expect(makeCommand().parseAsync(args, { from: 'user', })).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it('documents optional arguments and the shared help footer', () => {
    const command = makeCommand();
    const messages: string[] = [];
    command.configureOutput({ writeOut: (message) => { messages.push(message); }, }).outputHelp();
    const help = messages.join('').replace(/\s+/g, ' ');
    expect(command.name()).toBe('update');
    expect(help).toContain('[repository] [pluginname] [version]');
    expect(help).toContain('@owner/repository');
    expect(help).toContain('all managed plugins');
    expect(help).toContain('recorded version');
    expect(help).toContain('Copyright');
    expect(help).toContain('https://specdd.ai');
    expect(help).toContain('https://github.com/specdd/cli');
  });

  it('uses process cwd by default and propagates service errors', async () => {
    update.mockRejectedValue(new Error('update failed'));
    await expect(createPluginUpdateCommand({ pluginUpdater: { update, }, }).parseAsync([], { from: 'user', }))
      .rejects.toThrow('update failed');
    expect(update.mock.calls[0]?.[0].targetDirectoryPath).toBe(process.cwd());
  });
});
