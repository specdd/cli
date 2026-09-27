import { PluginSource, PluginSourceError } from './plugin-source.js';

describe('PluginSource', () => {
  const source = new PluginSource();

  it.each(['review', 'code-review', 'Review_2', 'review.rules',])('accepts plugin name %s during repository resolution', (name) => {
    expect(source.resolve('@acme/repo', name).repositoryFilePath).toBe(`.plugins/${name}/plugin.md`);
  });

  it('expands GitHub shorthand to SSH and preserves the requested version', () => {
    expect(source.resolve('@acme/specdd-plugins', 'review', 'v1.2.0')).toEqual({
      repositoryUrl: 'git@github.com:acme/specdd-plugins.git',
      originRepositoryUrl: 'git@github.com:acme/specdd-plugins.git',
      repositoryCoordinates: 'github.com/acme/specdd-plugins',
      isOfficialRepository: false,
      repositoryFilePath: '.plugins/review/plugin.md',
      repositorySignaturePath: '.plugins/review/plugin.md.asc',
      relativeDestination: 'plugins/github.com/acme/specdd-plugins/review/plugin.md',
      gitRef: 'v1.2.0',
      version: 'v1.2.0',
    });
  });

  it.each([
    '@specdd/plugins', '@SpecDD/any-repo', '@specdd/specdd.git',
    'git@github.com:specdd/plugins.git', 'github.com:specdd/plugins',
    'ssh://git@github.com/specdd/plugins.git', 'ssh://git@GITHUB.COM:22/SpEcDd/plugins',
    'ssh://git@github.com:443/specdd/plugins', 'https://github.com:443/specdd/plugins.git/',
    'https://GITHUB.COM/SpecDD/another-repository', 'https://github.com:8443/specdd/plugins',
    'https://user:password@github.com/%73pecdd/plugins',
  ])('recognizes official organization source %s', (repository) => {
    expect(source.resolve(repository, 'review').isOfficialRepository).toBe(true);
  });

  it.each([
    '@specdd-tools/plugins', '@others/specdd', 'https://github.com/specdd2/plugins',
    'https://github.com.evil.test/specdd/plugins', 'https://gitlab.com/specdd/plugins',
    'https://github.com/others/specdd/plugins', 'https://github.com@evil.test/specdd/plugins',
    'git@notgithub.com:specdd/plugins', 'https://github.com/specdd',
  ])('does not classify a lookalike or different source as official: %s', (repository) => {
    expect(source.resolve(repository, 'review').isOfficialRepository).toBe(false);
  });

  it.each([
    'https://github.com/acme/repo.git/',
    'ssh://git@github.com/acme/repo.git',
    'git@github.com:acme/repo',
    '@acme/repo',
  ])('uses the same coordinates for %s', (repository) => {
    expect(source.resolve(repository, 'review').repositoryCoordinates).toBe('github.com/acme/repo');
  });

  it('preserves namespaces, path case, SSH aliases, and nondefault ports', () => {
    expect(source.resolve('ssh://git@WorkAlias:2222/group/Team/Repo.git', 'review').repositoryCoordinates)
      .toBe('workalias~2222/group/Team/Repo');
    expect(source.resolve('ssh://git@host:22/group/repo', 'review').repositoryCoordinates).toBe('host/group/repo');
  });

  it('preserves explicit HTTPS transport while removing credentials from provenance', () => {
    const result = source.resolve('https://token:secret@host/team/repo', 'review');
    expect(result.repositoryUrl).toBe('https://token:secret@host/team/repo');
    expect(result.originRepositoryUrl).toBe('https://host/team/repo');
    expect(source.resolve('ssh://git:secret@host/team/repo', 'review').originRepositoryUrl)
      .toBe('ssh://git@host/team/repo');
  });

  it.each([
    'git@host:team/repo', 'git@host:team/repo.git', 'git@host:team/repo.git.git',
    'host:team/repo', 'ssh://git@host/team/repo', 'ssh://git@host/team/repo.git',
    'https://host/team/repo', 'https://host/team/repo.git',
    'https://host/team/r%65po.git', 'ssh://git@host/t%65am/repo',
  ])('preserves the remote path in the origin for %s', (repository) => {
    const result = source.resolve(repository, 'review');
    expect(result.repositoryUrl).toBe(repository);
    expect(result.originRepositoryUrl).toBe(repository);
    expect(source.resolve(result.originRepositoryUrl, 'review').relativeDestination).toBe(result.relativeDestination);
    expect(source.resolve(`${repository}/`, 'review').originRepositoryUrl).toBe(repository);
  });

  it.each(['https://host/t%65am/r%65po.git', 'ssh://git@host/t%65am/r%65po.git',])
    ('decodes URL syntax for coordinates while preserving the transport path: %s', (repository) => {
      expect(source.resolve(repository, 'review')).toMatchObject({
        repositoryUrl: repository,
        originRepositoryUrl: repository,
        repositoryCoordinates: 'host/team/repo',
      });
    });

  it.each([
    'git@host:team/r%65po.git', 'host:team/r%65po.git', 'git@host:t%65am/repo',
    'git@host:team/repo%', 'git@host:team/%ZZ', 'git@host:team/repo+extra',
    'git@host:team/repo;extra', 'git@host:team/répo',
  ])('rejects unsupported literal SCP path characters: %s', (repository) => {
    expect(() => source.resolve(repository, 'review')).toThrow('Invalid repository path');
  });

  it('distinguishes omitted versions from a literal latest ref', () => {
    expect(source.resolve('@acme/repo', 'review')).toMatchObject({ version: 'latest', gitRef: undefined, });
    expect(source.resolve('@acme/repo', 'review', 'latest')).toMatchObject({ version: 'latest', gitRef: 'latest', });
    expect(source.resolve('@acme/repo', 'review', 'abc1234').version).toBe('abc1234');
  });

  it.each([
    '', '@owner', '@owner/repo/extra', 'file:///tmp/repo', 'ext::bad', '-bad',
    'https://host/', 'https://host/a/../repo', 'https://host/a/%2e%2e/repo',
    'https://host/a%2frepo', 'https://host/a%5crepo', 'https://host/repo?q=x',
    'https://host/repo#main', 'https://host/a//repo', 'git@host:../repo',
    'https://host/repo%00', 'https://host/%ZZ', 'https://host/CON', 'https://host/repo.',
    'https://host:99999/repo', 'https://[::1]/repo', 'ssh://git@host./team/repo',
  ])('rejects invalid or unsafe repository %s', (repository) => {
    expect(() => source.resolve(repository, 'review')).toThrow(PluginSourceError);
  });

  it.each(['', '.', '..', '../review', '/review', 'a/b', 'a\\b', 'a:b', 'NUL', 'review.', 'a\0b',])
    ('rejects unsafe plugin name %s', (name) => {
      expect(() => source.resolve('@acme/repo', name)).toThrow(PluginSourceError);
    });

  it.each(['', ' ', '-x', 'HEAD~1', 'main^{tree}', 'a\nb',])('rejects invalid ref %s', (version) => {
    expect(() => source.resolve('@acme/repo', 'review', version)).toThrow(PluginSourceError);
  });
});
