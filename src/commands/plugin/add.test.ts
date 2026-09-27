import { jest } from '@jest/globals';
import { createPluginAddCommand } from './add.js';
import type { PluginInstaller } from '../../services/plugin-installer/plugin-installer.js';

describe('plugin add command', () => {
  const add = jest.fn<PluginInstaller['add']>();
  const makeCommand = () => createPluginAddCommand({ pluginInstaller: { add, }, }, () => '/project')
    .exitOverride().configureOutput({ writeErr: () => {}, });

  beforeEach(() => { add.mockReset(); });

  it.each([undefined, 'v1.2.0', 'latest', 'abc1234',])('forwards version %s verbatim', async (version) => {
    const args = ['@acme/repo', 'review', ...(undefined === version ? [] : [version,]),];
    await makeCommand().parseAsync(args, { from: 'user', });
    expect(add).toHaveBeenCalledWith({ targetDirectoryPath: '/project', repository: '@acme/repo', pluginName: 'review', version, });
  });

  it.each([{ args: [], }, { args: ['@acme/repo',], }, { args: ['@acme/repo', 'review', 'v1', 'extra',], },])('rejects invalid argument counts: $args', async ({ args }) => {
    await expect(makeCommand().parseAsync(args, { from: 'user', })).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });

  it('documents arguments and project help', () => {
    const command = makeCommand();
    const output: string[] = [];
    command.configureOutput({ writeOut: (message) => { output.push(message); }, }).outputHelp();
    expect(output.join('')).toContain('<repository> <pluginname> [version]');
    expect(output.join('')).toContain('https://specdd.ai');
    expect(output.join('')).toContain('https://github.com/specdd/cli');
  });

  it('uses the current working directory by default and propagates service errors', async () => {
    add.mockRejectedValue(new Error('install failed'));
    const command = createPluginAddCommand({ pluginInstaller: { add, }, });
    await expect(command.parseAsync(['@acme/repo', 'review',], { from: 'user', })).rejects.toThrow('install failed');
    expect(add.mock.calls[0]?.[0].targetDirectoryPath).toBe(process.cwd());
  });
});
