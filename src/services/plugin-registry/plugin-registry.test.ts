import { jest } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystem } from '../../infrastructure/file-system.js';
import { pluginRegistrationsMatch, PluginRegistry, PluginRegistryError, type PluginRegistryEntry } from './plugin-registry.js';

const entry: PluginRegistryEntry = {
  src: 'plugins/host/team/repo/review/plugin.md',
  origin: 'git@host:team/repo.git#abc',
  sig: 'a'.repeat(64),
  version: 'latest',
};

describe('pluginRegistrationsMatch', () => {
  it('matches absent registrations only with another absent registration', () => {
    expect(pluginRegistrationsMatch(undefined, undefined)).toBe(true);
    expect(pluginRegistrationsMatch(entry, undefined)).toBe(false);
    expect(pluginRegistrationsMatch(undefined, entry)).toBe(false);
  });

  it('ignores metadata changes when all registration fields match', () => {
    const preceding = { ...entry, note: { text: 'before', }, enabled: true, };
    const current = { ...entry, note: { text: 'after', }, owner: 'operator', };

    expect(pluginRegistrationsMatch(preceding, current)).toBe(true);
  });

  it.each([
    { field: 'src', value: `./${entry.src}`, },
    { field: 'origin', value: `${entry.origin}def`, },
    { field: 'sig', value: 'b'.repeat(64), },
    { field: 'version', value: 'v2.0.0', },
  ])('requires an exact match for $field', ({ field, value }) => {
    const changed = { ...entry, [field]: value, };

    expect(pluginRegistrationsMatch(entry, changed)).toBe(false);
    expect(pluginRegistrationsMatch(changed, entry)).toBe(false);
  });
});

describe('PluginRegistry', () => {
  let directory: string;
  let path: string;
  let fileSystem: FileSystem;
  let registry: PluginRegistry;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'specdd-plugin-registry-'));
    path = join(directory, 'plugins.json');
    fileSystem = new FileSystem();
    registry = new PluginRegistry(fileSystem, () => '/home/alex');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, });
  });

  it('treats a missing registry as empty without creating it', async () => {
    await expect(registry.read(path)).resolves.toEqual([]);
    await expect(fileSystem.exists(path)).resolves.toBe(false);
  });

  it('resolves relative, absolute, parent, and home paths relative to the registry', () => {
    const base = '/project/.specdd/plugins.json';
    expect(registry.resolveSourcePath(base, '../local/plugin.md')).toBe('/project/local/plugin.md');
    expect(registry.resolveSourcePath(base, '/shared/plugin.md')).toBe('/shared/plugin.md');
    expect(registry.resolveSourcePath(base, '~/plugins/plugin.md')).toBe('/home/alex/plugins/plugin.md');
    expect(registry.resolveSourcePath(base, '~')).toBe('/home/alex');
  });

  it('creates and updates entries while preserving unrelated metadata and spelling', async () => {
    const external = { ...entry, src: '~/missing/plugin.md', origin: 'local', extra: { retained: true, }, };
    await writeFile(path, JSON.stringify([external, { ...entry, src: `./${entry.src}`, },]));
    await registry.upsert(path, { ...entry, version: 'v1.2.0', });
    expect(await registry.read(path)).toEqual([external, { ...entry, src: `./${entry.src}`, version: 'v1.2.0', },]);
    await registry.upsert(path, { ...entry, src: 'plugins/other/plugin.md', });
    expect(await registry.read(path)).toHaveLength(3);
  });

  it('writes the four registry fields for a new installation', async () => {
    await registry.upsert(path, entry);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([entry,]);
  });

  it('requires absence when conditionally creating a registration', async () => {
    await registry.upsert(path, entry, null);
    const before = await readFile(path);
    await expect(registry.upsert(path, { ...entry, version: 'v2', }, null)).rejects.toThrow('registration changed');
    expect(await readFile(path)).toEqual(before);
  });

  it('conditionally replaces a matching registration while preserving current metadata', async () => {
    const external = { ...entry, src: '~/other/plugin.md', };
    await writeFile(path, JSON.stringify([external, { ...entry, note: { edited: true, }, },]));
    await registry.upsert(path, { ...entry, version: 'v2', }, entry);
    expect(await registry.read(path)).toEqual([external, { ...entry, version: 'v2', note: { edited: true, }, },]);
  });

  it.each(['missing', 'src', 'origin', 'sig', 'version',])('preserves a conflicting registration: %s', async (field) => {
    const changes: Record<string, string> = {
      src: `./${entry.src}`, origin: 'manual', sig: 'b'.repeat(64), version: 'v2',
    };
    const edited = JSON.stringify('missing' === field ? [] : [{ ...entry, [field]: changes[field], },]);
    await writeFile(path, edited);
    await expect(registry.upsert(path, { ...entry, version: 'v3', }, entry)).rejects.toThrow('registration changed');
    expect(await readFile(path, 'utf8')).toBe(edited);
  });

  it.each([
    '{', '{}', 'null', '[null]', '[[]]',
    JSON.stringify([{ ...entry, version: undefined, },]),
    JSON.stringify([{ ...entry, src: '', },]),
    JSON.stringify([{ ...entry, sig: 'A'.repeat(64), },]),
    JSON.stringify([{ ...entry, sig: 'abc', },]),
    JSON.stringify([{ ...entry, origin: 12, },]),
    JSON.stringify([entry, { ...entry, src: `./${entry.src}`, },]),
  ])('rejects malformed data without modifying it: %s', async (data) => {
    await writeFile(path, data);
    await expect(registry.upsert(path, entry)).rejects.toBeInstanceOf(PluginRegistryError);
    expect(await readFile(path, 'utf8')).toBe(data);
  });

  it('reports read errors instead of treating them as an empty registry', async () => {
    jest.spyOn(fileSystem, 'readFile').mockRejectedValue(new Error('permission denied'));
    await expect(registry.read(path)).rejects.toThrow('permission denied');
  });

  it('leaves the registry intact when atomic replacement fails', async () => {
    await writeFile(path, JSON.stringify([entry,]));
    jest.spyOn(fileSystem, 'writeFileAtomic').mockRejectedValue(new Error('disk full'));
    await expect(registry.upsert(path, { ...entry, version: 'v2', })).rejects.toThrow('disk full');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([entry,]);
  });
});
