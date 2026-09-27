import { jest } from '@jest/globals';
import * as fileSystemPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystem } from './file-system.js';

describe('FileSystem', () => {
  it('inspects symlinks without following them and resolves their real paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specdd-fs-links-'));
    const fileSystem = new FileSystem();
    try {
      await writeFile(join(directory, 'target'), 'data');
      await symlink(join(directory, 'target'), join(directory, 'link'));
      expect((await fileSystem.lstat(join(directory, 'link'))).isSymbolicLink()).toBe(true);
      expect(await fileSystem.realpath(join(directory, 'link'))).toBe(join(directory, 'target'));
      await expect(fileSystem.lstat(join(directory, 'missing'))).rejects.toMatchObject({ code: 'ENOENT', });
    } finally {
      await rm(directory, { recursive: true, force: true, });
    }
  });

  it('atomically replaces exact bytes and cleans staging files when rename fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specdd-fs-atomic-'));
    const fileSystem = new FileSystem();
    try {
      const path = join(directory, 'file');
      await writeFile(path, 'before');
      await fileSystem.writeFileAtomic(path, new Uint8Array([0, 255, 13, 10,]));
      expect(await readFile(path)).toEqual(Buffer.from([0, 255, 13, 10,]));
      await mkdir(join(directory, 'occupied'));
      await writeFile(join(directory, 'occupied', 'child'), 'keep');
      await expect(fileSystem.writeFileAtomic(join(directory, 'occupied'), Buffer.from('new'))).rejects.toThrow();
      expect((await readdir(directory)).sort()).toEqual(['file', 'occupied',]);
      expect(await readFile(join(directory, 'occupied', 'child'), 'utf8')).toBe('keep');
      await expect(fileSystem.writeFileAtomic(join(directory, 'missing', 'file'), Buffer.from('new')))
        .rejects.toMatchObject({ code: 'ENOENT', });
    } finally {
      await rm(directory, { recursive: true, force: true, });
    }
  });

  it('preserves the prior destination and both errors when replacement and staging cleanup fail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specdd-fs-atomic-cleanup-'));
    const path = join(directory, 'file');
    const precedingBytes = Buffer.from('preceding contents\r\n');
    const replacementError = Object.assign(new Error('replacement denied'), { code: 'EACCES', });
    const cleanupError = Object.assign(new Error('cleanup denied'), { code: 'EPERM', });
    const rename = jest.fn<typeof fileSystemPromises.rename>().mockRejectedValue(replacementError);
    const remove = jest.fn<typeof fileSystemPromises.rm>().mockRejectedValue(cleanupError);

    try {
      await writeFile(path, precedingBytes);
      jest.unstable_mockModule('node:fs/promises', () => ({ ...fileSystemPromises, rename, rm: remove, }));
      await jest.isolateModulesAsync(async () => {
        const { FileSystem: IsolatedFileSystem } = await import('./file-system.js');
        const failure: unknown = await new IsolatedFileSystem().writeFileAtomic(path, Buffer.from('replacement'))
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) {
          throw new Error('Expected both filesystem failures to be retained.');
        }

        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toBe(replacementError);
        expect(failure.errors[1]).toBe(cleanupError);
        expect(failure.message).toContain(path);
      });
      expect(rename).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(await readFile(path)).toEqual(precedingBytes);
    } finally {
      jest.unstable_mockModule('node:fs/promises', () => fileSystemPromises);
      jest.resetModules();
      await rm(directory, { recursive: true, force: true, });
    }
  });

  it('holds an exclusive lock across processes and releases it after success and failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specdd-fs-lock-'));
    const path = join(directory, 'lock');
    const fileSystem = new FileSystem();
    try {
      await expect(fileSystem.withExclusiveLock(path, async () => {
        await expect(fileSystem.withExclusiveLock(path, async () => 'wrong')).rejects.toMatchObject({ code: 'EEXIST', });
        const child = spawnSync(process.execPath, ['-e', 'require("node:fs").openSync(process.argv[1], "wx")', path,]);
        expect(child.status).not.toBe(0);
        expect(child.stderr.toString()).toContain('EEXIST');
        return 'result';
      })).resolves.toBe('result');
      expect(await fileSystem.exists(path)).toBe(false);
      await expect(fileSystem.withExclusiveLock(path, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
      expect(await fileSystem.exists(path)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true, });
    }
  });

  it('requires explicit recursive removal for a directory tree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'specdd-fs-remove-'));
    const fileSystem = new FileSystem();
    try {
      await writeFile(join(directory, 'child'), 'data');
      await expect(fileSystem.removePath(directory)).rejects.toThrow();
      await fileSystem.removePath(directory, { recursive: true, });
      expect(await fileSystem.exists(directory)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true, });
    }
  });

  it.each([false, true,])('reports lock-release failure with callback failure: %s', async (callbackFails) => {
    const directory = await mkdtemp(join(tmpdir(), 'specdd-fs-release-'));
    const lock = join(directory, 'lock');
    try {
      const promise = new FileSystem().withExclusiveLock(lock, async () => {
        await rm(lock);
        if (callbackFails) {
          throw new Error('callback failed');
        }
      });
      if (callbackFails) {
        await expect(promise).rejects.toBeInstanceOf(AggregateError);
      } else {
        await expect(promise).rejects.toMatchObject({ code: 'ENOENT', });
      }
    } finally {
      await rm(directory, { recursive: true, force: true, });
    }
  });

  it('checks paths, creates directories, and reads and writes bytes', async () => {
    const directoryPath = await mkdtemp(join(tmpdir(), 'specdd-file-system-test-'));
    const nestedDirectoryPath = join(directoryPath, 'nested');
    const filePath = join(nestedDirectoryPath, 'file.txt');
    const fileSystem = new FileSystem();

    try {
      await expect(fileSystem.exists(filePath)).resolves.toBe(false);
      await expect(fileSystem.isDirectory(nestedDirectoryPath)).resolves.toBe(false);
      await fileSystem.createDirectory(nestedDirectoryPath, {
        recursive: true,
      });
      await fileSystem.writeFile(filePath, new TextEncoder().encode('content'));

      await expect(fileSystem.exists(filePath)).resolves.toBe(true);
      await expect(fileSystem.isDirectory(nestedDirectoryPath)).resolves.toBe(true);
      await expect(fileSystem.isDirectory(filePath)).resolves.toBe(false);
      await expect(readFile(filePath, 'utf8')).resolves.toBe('content');
      await expect(fileSystem.readFile(filePath).then((data) => new TextDecoder().decode(data))).resolves.toBe(
        'content',
      );
    } finally {
      await rm(directoryPath, {
        force: true,
        recursive: true,
      });
    }
  });
});
