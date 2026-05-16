import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TempDirectory } from './temp-directory.js';

describe('TempDirectory', () => {
  it('creates a unique directory under the operating system temporary directory', async () => {
    const tempDirectory = new TempDirectory();
    const directoryPath = await tempDirectory.create('specdd-temp-directory-test-');

    try {
      expect(directoryPath.startsWith(join(tmpdir(), 'specdd-temp-directory-test-'))).toBe(true);
      await expect(stat(directoryPath)).resolves.toMatchObject({
        isDirectory: expect.any(Function),
      });
    } finally {
      await rm(directoryPath, {
        force: true,
        recursive: true,
      });
    }
  });
});
