import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class TempDirectory {
  public async create(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix));
  }
}

export type TempDirectoryDependency = Pick<TempDirectory, 'create'>;
