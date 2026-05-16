import {
  SpecDDInvalidVersionError,
  SpecDDVersion,
} from './specdd-version.js';

describe('SpecDDVersion', () => {
  it('accepts dotted numeric versions', () => {
    const specDDVersion = new SpecDDVersion();

    expect(specDDVersion.isValid('1.2')).toBe(true);
    expect(specDDVersion.isValid('1.2.3')).toBe(true);
  });

  it('rejects invalid versions', () => {
    const specDDVersion = new SpecDDVersion();

    expect(specDDVersion.isValid('v1.2.3')).toBe(false);
    expect(specDDVersion.isValid('next')).toBe(false);
  });

  it('suggests numeric version for versions with a leading v', () => {
    const specDDVersion = new SpecDDVersion();

    expect(specDDVersion.suggest('v1.2.3')).toBe('1.2.3');
    expect(specDDVersion.suggest('next')).toBeNull();
  });

  it('raises an invalid version error with suggestion', () => {
    const specDDVersion = new SpecDDVersion();

    expect(() => specDDVersion.validate('v1.2.3')).toThrow('Invalid SpecDD version: v1.2.3. Did you mean 1.2.3?');
    expect(() => specDDVersion.validate('v1.2.3')).toThrow(SpecDDInvalidVersionError);
  });

  it('compares versions numerically', () => {
    const specDDVersion = new SpecDDVersion();

    expect(specDDVersion.compare('1.2.3', '1.2.2')).toBe(1);
    expect(specDDVersion.compare('1.2.2', '1.2.3')).toBe(-1);
    expect(specDDVersion.compare('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats missing version parts as zero when comparing', () => {
    const specDDVersion = new SpecDDVersion();

    expect(specDDVersion.compare('1.2', '1.2.0')).toBe(0);
    expect(specDDVersion.compare('1.2.1', '1.2')).toBe(1);
  });
});
