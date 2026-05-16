import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystem } from './file-system.js';

describe('FileSystem', () => {
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
