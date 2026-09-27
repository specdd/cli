import { jest } from '@jest/globals';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../../cli-error.js';
import { FileSystem } from '../../infrastructure/file-system.js';
import { PluginRegistry, PluginRegistryError, type PluginRegistryEntry } from '../../services/plugin-registry/plugin-registry.js';
import {
  createPluginListCommand,
  PluginListInvalidFormatError,
  renderPluginList,
  resolvePluginListOutputFormat,
  type PluginListResult,
} from './list.js';

const plugins: PluginRegistryEntry[] = [
  {
    src: 'plugins/github.com/acme/plugins/review/plugin.md',
    origin: `git@github.com:acme/plugins.git#${'a'.repeat(40)}`,
    sig: 'b'.repeat(64),
    version: 'v1.2.0',
    note: 'Locally maintained metadata',
  },
  { src: '~/plugins/external.md', origin: 'local', sig: 'c'.repeat(64), version: 'latest', },
  { src: '/external/absolute.md', origin: 'local', sig: 'd'.repeat(64), version: 'stable', },
  { src: '../external/relative.md', origin: 'local', sig: 'e'.repeat(64), version: 'main', },
];

const result: PluginListResult = {
  rootDirectoryPath: '/project',
  registryPath: '/project/.specdd/plugins.json',
  plugins,
};

const createFixture = (entries: PluginRegistryEntry[] = plugins) => {
  const read = jest.fn<PluginRegistry['read']>().mockResolvedValue(entries);
  const output: string[] = [];
  const command = createPluginListCommand(
    { pluginRegistry: { read, }, },
    () => '/project/nested/..',
    (message) => { output.push(message); },
  );
  return { command, output, read, };
};

describe('plugin list command', () => {
  it('describes both output flags, the default, and the shared help footer', () => {
    const { command, output } = createFixture();
    command.configureOutput({ writeOut: (message) => { output.push(message); }, }).outputHelp();
    const help = output.join('');

    expect(command.name()).toBe('list');
    expect(command.description()).toBe('List installed SpecDD plugins.');
    expect(help).toContain('--output <format>');
    expect(help).toContain('--format');
    expect(help).toContain('Output format: text, json, or json-extended.');
    expect(help).toContain('(default: "text")');
    expect(help).toContain('Copyright (c) 2026 Matīss Treinis and SpecDD contributors');
    expect(help).toContain('Spec help: https://specdd.ai');
    expect(help).toContain('CLI help: https://github.com/specdd/cli');
  });

  it.each(['text', 'json', 'json-extended',])('accepts the %s output format', (format) => {
    expect(resolvePluginListOutputFormat(format)).toBe(format);
  });

  it('rejects unsupported render formats with a CLI error', () => {
    expect(() => resolvePluginListOutputFormat('yaml')).toThrow(PluginListInvalidFormatError);
    expect(() => renderPluginList(result, 'yaml')).toThrow('Unsupported plugin list output format: yaml');
    expect(new PluginListInvalidFormatError('yaml')).toBeInstanceOf(CliError);
  });

  it('reads the current project registry and defaults to text in registry order', async () => {
    const { command, output, read } = createFixture();
    await command.parseAsync([], { from: 'user', });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('/project/.specdd/plugins.json');
    expect(output).toEqual([plugins.map((entry) => (
      `${entry.src}\n  Version: ${entry.version}\n  Origin: ${entry.origin}\n  SHA-256: ${entry.sig}`
    )).join('\n\n') + '\n',]);
  });

  it('renders an empty list as concise text', async () => {
    const { command, output } = createFixture([]);
    await command.parseAsync([], { from: 'user', });
    expect(output).toEqual(['No plugins installed.\n',]);
  });

  it.each(['--output', '--format',])('renders compact JSON using %s', async (flag) => {
    const { command, output } = createFixture();
    await command.parseAsync([flag, 'json',], { from: 'user', });

    expect(JSON.parse(output.join(''))).toEqual({
      rootDirectoryPath: '/project',
      registryPath: '/project/.specdd/plugins.json',
      plugins: plugins.map(({ src, origin, sig, version }) => ({ src, origin, sig, version, })),
    });
    expect(output.join('')).not.toContain('note');
    expect(output.join('').endsWith('\n')).toBe(true);
  });

  it.each(['--output', '--format',])('preserves all registry metadata in extended JSON using %s', async (flag) => {
    const { command, output } = createFixture();
    await command.parseAsync([flag, 'json-extended',], { from: 'user', });
    expect(JSON.parse(output.join(''))).toEqual(result);
    expect(output.join('').endsWith('\n')).toBe(true);
  });

  it.each([
    ['--format', 'text', '--output', 'json',],
    ['--output', 'text', '--format', 'json',],
  ])('uses the last supplied output value for %j', async (...args) => {
    const { command, output } = createFixture([]);
    await command.parseAsync(args, { from: 'user', });
    expect(JSON.parse(output.join('')).plugins).toEqual([]);
  });

  it.each(['--output', '--format',])('rejects unsupported %s before reading the registry', async (flag) => {
    const { command, output, read } = createFixture();
    await expect(command.parseAsync([flag, 'yaml',], { from: 'user', })).rejects.toBeInstanceOf(PluginListInvalidFormatError);
    expect(read).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it.each([
    ['extra',],
    ['--output',],
    ['--format',],
    ['--unknown',],
  ])('rejects invalid arguments %j before reading the registry', async (...args) => {
    const { command, output, read } = createFixture();
    command.exitOverride().configureOutput({ writeErr: () => {}, });
    await expect(command.parseAsync(args, { from: 'user', })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });

  it('propagates registry failures without writing output', async () => {
    const { command, output, read } = createFixture();
    const error = new PluginRegistryError('Cannot read registry: permission denied');
    read.mockRejectedValue(error);
    await expect(command.parseAsync([], { from: 'user', })).rejects.toBe(error);
    expect(output).toEqual([]);
  });

  it('uses process cwd and stdout when providers are omitted', async () => {
    const cwd = jest.spyOn(process, 'cwd').mockReturnValue('/project');
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const read = jest.fn<PluginRegistry['read']>().mockResolvedValue([]);

    try {
      await createPluginListCommand({ pluginRegistry: { read, }, }).parseAsync([], { from: 'user', });
      expect(read).toHaveBeenCalledWith('/project/.specdd/plugins.json');
      expect(stdout).toHaveBeenCalledWith('No plugins installed.\n');
    } finally {
      cwd.mockRestore();
      stdout.mockRestore();
    }
  });
});

describe('plugin list registry integration', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'specdd-plugin-list-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, });
  });

  const run = async (format: string): Promise<string> => {
    const output: string[] = [];
    await createPluginListCommand(
      { pluginRegistry: new PluginRegistry(new FileSystem()), },
      () => directory,
      (message) => { output.push(message); },
    ).parseAsync(['--output', format,], { from: 'user', });
    return output.join('');
  };

  it('lists an absent registry without a bootstrap or creating files', async () => {
    expect(await run('text')).toBe('No plugins installed.\n');
    expect(JSON.parse(await run('json'))).toEqual({
      rootDirectoryPath: directory,
      registryPath: join(directory, '.specdd/plugins.json'),
      plugins: [],
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    { name: 'empty', entries: [], },
    { name: 'registered', entries: plugins, },
  ])('lists $name entries without reading plugin files or changing the registry', async ({ entries }) => {
    await mkdir(join(directory, '.specdd'));
    const registryPath = join(directory, '.specdd/plugins.json');
    const content = JSON.stringify(entries);
    await writeFile(registryPath, content);

    expect(JSON.parse(await run('json-extended')).plugins).toEqual(entries);
    expect(await readFile(registryPath, 'utf8')).toBe(content);
    expect(await readdir(join(directory, '.specdd'))).toEqual(['plugins.json',]);
  });

  it.each(['{invalid', '{}', '[{"src":"plugin.md"}]',])('rejects an invalid registry: %s', async (content) => {
    await mkdir(join(directory, '.specdd'));
    const registryPath = join(directory, '.specdd/plugins.json');
    await writeFile(registryPath, content);
    await expect(run('json')).rejects.toBeInstanceOf(PluginRegistryError);
    expect(await readFile(registryPath, 'utf8')).toBe(content);
  });
});
