import type { ConfigReader } from '../config-reader.js';

export type Environment = Readonly<Record<string, string | undefined>>;

export class EnvironmentReader implements ConfigReader {
  private readonly environment: Environment;

  public constructor(environment: Environment) {
    this.environment = environment;
  }

  public get(key: string): string | null {
    const environmentKey = `SPECDD_${key.toUpperCase()}`;
    const value = this.environment[environmentKey];

    if (undefined === value) {
      return null;
    }

    return value;
  }
}
