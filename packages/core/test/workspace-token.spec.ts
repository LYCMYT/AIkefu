import {
  createWorkspaceToken,
  hashWorkspaceToken,
  isWorkspaceToken,
} from '../src';

describe('workspace token', () => {
  it('creates opaque, unique tokens and stores only deterministic hashes', () => {
    const first = createWorkspaceToken();
    const second = createWorkspaceToken();

    expect(first).not.toEqual(second);
    expect(first).toMatch(/^dws_[A-Za-z0-9_-]{43}$/);
    expect(isWorkspaceToken(first)).toBe(true);
    expect(hashWorkspaceToken(first)).toEqual(hashWorkspaceToken(first));
    expect(hashWorkspaceToken(first)).not.toContain(first);
    expect(hashWorkspaceToken(first)).toHaveLength(64);
  });

  it('rejects malformed tokens before hashing database lookups', () => {
    expect(isWorkspaceToken('')).toBe(false);
    expect(isWorkspaceToken('raw-cookie-or-platform-token')).toBe(false);
    expect(() => hashWorkspaceToken('raw-cookie-or-platform-token')).toThrow(
      'Invalid demo workspace token',
    );
  });
});
