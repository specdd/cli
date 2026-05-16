import { EnvironmentReader } from './environment-reader.js';

describe('EnvironmentReader', () => {
  it('reads SPECDD-prefixed uppercase environment variables', () => {
    const reader = new EnvironmentReader({
      SPECDD_RELEASE: 'latest',
    });

    expect(reader.get('release')).toBe('latest');
  });

  it('returns null when the environment variable is missing', () => {
    const reader = new EnvironmentReader({});

    expect(reader.get('release')).toBeNull();
  });

  it('returns an empty string when the environment variable is present but empty', () => {
    const reader = new EnvironmentReader({
      SPECDD_RELEASE: '',
    });

    expect(reader.get('release')).toBe('');
  });

  it('ignores unprefixed environment variables', () => {
    const reader = new EnvironmentReader({
      RELEASE: 'latest',
    });

    expect(reader.get('release')).toBeNull();
  });

  it('ignores wrongly cased environment variable names', () => {
    const reader = new EnvironmentReader({
      SPECDD_release: 'latest',
    });

    expect(reader.get('release')).toBeNull();
  });
});
