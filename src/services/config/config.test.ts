import { ConfigDefaults } from './config-defaults.js';
import { Config } from './config.js';
import type { ConfigReader, ConfigValue } from './config-reader.js';
import type { ConfigWarningStream } from './config.js';

class StubReader implements ConfigReader {
  public constructor(private readonly values: Readonly<Record<string, ConfigValue | null>>) {}

  public get(key: string): ConfigValue | null {
    return this.values[key] ?? null;
  }
}

class MemoryStream implements ConfigWarningStream {
  public readonly messages: string[] = [];

  public write(message: string): void {
    this.messages.push(message);
  }
}

class ThrowingStream implements ConfigWarningStream {
  public write(): void {
    throw new Error('write failed');
  }
}

describe('Config', () => {
  it('returns the first non-null reader value', () => {
    const defaults = new ConfigDefaults({
      release: 'configured-default',
    });
    const config = new Config([
      new StubReader({ release: null }),
      new StubReader({ release: 'reader-value' }),
      new StubReader({ release: 'ignored-value' }),
    ], defaults);

    expect(config.get('release')).toBe('reader-value');
  });

  it('returns the call-provided default when readers do not provide a value', () => {
    const defaults = new ConfigDefaults({
      release: 'configured-default',
    });
    const config = new Config([
      new StubReader({}),
    ], defaults);

    expect(config.get('release', 'call-default')).toBe('call-default');
  });

  it('returns false as a call-provided default', () => {
    const defaults = new ConfigDefaults({
      debug: true,
    });
    const config = new Config([], defaults);

    expect(config.get('debug', false)).toBe(false);
  });

  it('returns zero as a call-provided default', () => {
    const defaults = new ConfigDefaults({
      retries: 3,
    });
    const config = new Config([], defaults);

    expect(config.get('retries', 0)).toBe(0);
  });

  it('returns the configured default when readers and call default do not provide a value', () => {
    const defaults = new ConfigDefaults({
      release: 'configured-default',
    });
    const config = new Config([], defaults);

    expect(config.get('release')).toBe('configured-default');
  });

  it('prefers reader values over call-provided and configured defaults', () => {
    const defaults = new ConfigDefaults({
      release: 'configured-default',
    });
    const config = new Config([
      new StubReader({ release: 'reader-value' }),
    ], defaults);

    expect(config.get('release', 'call-default')).toBe('reader-value');
  });

  it('prefers call-provided defaults over configured defaults', () => {
    const defaults = new ConfigDefaults({
      release: 'configured-default',
    });
    const config = new Config([], defaults);

    expect(config.get('release', 'call-default')).toBe('call-default');
  });

  it('returns null when no reader value or default is available', () => {
    const config = new Config([], new ConfigDefaults(), {
      stderr: new MemoryStream(),
    });

    expect(config.get('missing')).toBeNull();
  });

  it('warns when a requested key has no configured default', () => {
    const stderr = new MemoryStream();
    const config = new Config([], new ConfigDefaults(), {
      stderr,
    });

    config.get('missing');

    expect(stderr.messages).toEqual([
      '[warn] Config key "missing" has no configured default.\n',
    ]);
  });

  it('warns for undeclared keys even when a reader resolves the value', () => {
    const stderr = new MemoryStream();
    const config = new Config([
      new StubReader({ release: 'reader-value' }),
    ], new ConfigDefaults(), {
      stderr,
    });

    expect(config.get('release')).toBe('reader-value');
    expect(stderr.messages).toEqual([
      '[warn] Config key "release" has no configured default.\n',
    ]);
  });

  it('warns for undeclared keys even when a call-provided default resolves the value', () => {
    const stderr = new MemoryStream();
    const config = new Config([], new ConfigDefaults(), {
      stderr,
    });

    expect(config.get('release', 'call-default')).toBe('call-default');
    expect(stderr.messages).toEqual([
      '[warn] Config key "release" has no configured default.\n',
    ]);
  });

  it('does not warn when a requested key has a configured default', () => {
    const stderr = new MemoryStream();
    const defaults = new ConfigDefaults({
      release: 'configured-default',
    });
    const config = new Config([], defaults, {
      stderr,
    });

    config.get('release');

    expect(stderr.messages).toEqual([]);
  });

  it('does not throw when warning output fails', () => {
    const config = new Config([], new ConfigDefaults(), {
      stderr: new ThrowingStream(),
    });

    expect(() => config.get('missing')).not.toThrow();
  });

  it('preserves false and zero configured defaults', () => {
    const defaults = new ConfigDefaults({
      disabled: false,
      retries: 0,
    });
    const config = new Config([], defaults);

    expect(config.get('disabled')).toBe(false);
    expect(config.get('retries')).toBe(0);
  });

  it('preserves false and zero reader values', () => {
    const defaults = new ConfigDefaults({
      disabled: true,
      retries: 3,
    });
    const config = new Config([
      new StubReader({
        disabled: false,
        retries: 0,
      }),
    ], defaults);

    expect(config.get('disabled', true)).toBe(false);
    expect(config.get('retries', 2)).toBe(0);
  });
});
