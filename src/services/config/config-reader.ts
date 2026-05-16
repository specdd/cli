export type ConfigValue = string | number | boolean;

export interface ConfigReader {
  get(key: string): ConfigValue | null;
}
