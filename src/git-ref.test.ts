import { isValidGitRef } from './git-ref.js';

describe('isValidGitRef', () => {
  it.each([
    'main', 'feature/review', 'v1.2.0', 'latest', 'refs/heads/main', 'refs/tags/latest',
    'abc1234', 'a'.repeat(40), 'b'.repeat(64),
  ])('accepts literal ref or commit spelling %s', (ref) => {
    expect(isValidGitRef(ref)).toBe(true);
  });

  it.each([
    '', '-main', 'main branch', 'main\tbranch', 'main\nbranch', 'main\x00', 'main\x1f', 'main\x7f',
    'HEAD~1', 'main^', 'main:path', 'main?', 'main*', 'main[0]', 'main\\branch',
    'main..other', 'main@{1}', 'main//branch', 'main/', 'main.',
  ])('rejects ambiguous or unsafe ref spelling %j', (ref) => {
    expect(isValidGitRef(ref)).toBe(false);
  });
});
