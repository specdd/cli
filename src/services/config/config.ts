import { ConfigDefaults } from './config-defaults.js';
import type { ConfigReader, ConfigValue } from './config-reader.js';

export type ConfigWarningStream = {
  write(message: string): unknown;
};

export type ConfigOptions = {
  stderr?: ConfigWarningStream;
};

export class Config {
  private readonly readers: readonly ConfigReader[];

  private readonly defaults: ConfigDefaults;

  private readonly stderr: ConfigWarningStream;

  public constructor(
    readers: readonly ConfigReader[] = [],
    defaults: ConfigDefaults = new ConfigDefaults(),
    options: ConfigOptions = {},
  ) {
    this.readers = readers;
    this.defaults = defaults;
    this.stderr = options.stderr ?? process.stderr;
  }

  public get(key: string, defaultValue: ConfigValue | null = null): ConfigValue | null {
    if (!this.defaults.has(key)) {
      this.warnUndeclaredKey(key);
    }

    for (const reader of this.readers) {
      const value = reader.get(key);

      if (null !== value) {
        return value;
      }
    }

    if (null !== defaultValue) {
      return defaultValue;
    }

    return this.defaults.get(key);
  }

  private warnUndeclaredKey(key: string): void {
    try {
      this.stderr.write(`[warn] Config key "${key}" has no configured default.\n`);
    } catch {
      return;
    }
  }
}
