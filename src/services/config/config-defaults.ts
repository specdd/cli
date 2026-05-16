import type { ConfigValue } from './config-reader.js';

export const DEFAULT_CONFIG_VALUES = {
  log_level: 'info',
} as const satisfies Readonly<Record<string, ConfigValue>>;

export class ConfigDefaults {
  private readonly values: ReadonlyMap<string, ConfigValue>;

  public constructor(values: Readonly<Record<string, ConfigValue>> = DEFAULT_CONFIG_VALUES) {
    this.values = new Map(Object.entries(values));
  }

  public has(key: string): boolean {
    return this.values.has(key);
  }

  public get(key: string): ConfigValue | null {
    if (!this.values.has(key)) {
      return null;
    }

    return this.values.get(key) as ConfigValue;
  }
}
