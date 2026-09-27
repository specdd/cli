import { Command } from 'commander';
import { createPluginCommand } from './plugin.js';

describe('plugin command group', () => {
  it.each(['add', 'list', 'update',])('attaches and routes to the injected %s command', async (name) => {
    const calls: string[] = [];
    const add = new Command('add').action(() => { calls.push('add'); });
    const list = new Command('list').action(() => { calls.push('list'); });
    const update = new Command('update').action(() => { calls.push('update'); });
    const command = createPluginCommand({ pluginAddCommand: add, pluginListCommand: list, pluginUpdateCommand: update, });
    expect(command.name()).toBe('plugin');
    expect(command.commands).toEqual([add, list, update,]);
    await command.parseAsync([name,], { from: 'user', });
    expect(calls).toEqual([name,]);
  });

  it('lists subcommands and includes the shared help footer', () => {
    const output: string[] = [];
    createPluginCommand({ pluginAddCommand: new Command('add'), pluginListCommand: new Command('list'), pluginUpdateCommand: new Command('update'), })
      .configureOutput({ writeOut: (message) => { output.push(message); }, }).outputHelp();
    expect(output.join('')).toContain('add');
    expect(output.join('')).toContain('list');
    expect(output.join('')).toContain('update');
    expect(output.join('')).toContain('Copyright');
    expect(output.join('')).toContain('https://specdd.ai');
  });
});
