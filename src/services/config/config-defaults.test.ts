import { ConfigDefaults } from './config-defaults.js';

describe('ConfigDefaults', () => {
  it('provides info as the default log level', () => {
    const defaults = new ConfigDefaults();

    expect(defaults.get('log_level')).toBe('info');
  });

  it('returns configured string values', () => {
    const defaults = new ConfigDefaults({
      release: 'latest',
    });

    expect(defaults.get('release')).toBe('latest');
  });

  it('reports whether a key has a configured default', () => {
    const defaults = new ConfigDefaults({
      release: 'latest',
    });

    expect(defaults.has('release')).toBe(true);
    expect(defaults.has('missing')).toBe(false);
  });

  it('returns configured number values', () => {
    const defaults = new ConfigDefaults({
      retries: 0,
    });

    expect(defaults.get('retries')).toBe(0);
  });

  it('returns configured boolean values', () => {
    const defaults = new ConfigDefaults({
      debug: false,
    });

    expect(defaults.get('debug')).toBe(false);
  });

  it('returns null for missing keys', () => {
    const defaults = new ConfigDefaults();

    expect(defaults.get('release')).toBeNull();
  });

  it('does not change when the original defaults object is mutated', () => {
    const values = {
      release: 'latest',
    };
    const defaults = new ConfigDefaults(values);

    values.release = 'next';

    expect(defaults.get('release')).toBe('latest');
  });
});
