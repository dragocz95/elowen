import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync }));

import { detectGithubAuth } from '../../src/integrations/github/auth.js';

/** Route the two probes (`which gh`, `gh auth status`) to canned results so each posture is isolated.
 *  Anything else (incl. vitest's own worker-pool spawnSync calls, which our module mock also intercepts)
 *  gets a benign non-zero default so it can't leak into the assertions. */
function stub(opts: { ghOnPath: boolean; authStatus?: number; authOutput?: string }) {
  spawnSync.mockImplementation((bin?: string, args?: string[]) => {
    if (bin === 'which') return { status: opts.ghOnPath ? 0 : 1, stdout: '', stderr: '' };
    if (bin === 'gh' && args?.[0] === 'auth') return { status: opts.authStatus ?? 1, stdout: '', stderr: opts.authOutput ?? '' };
    return { status: 1, stdout: '', stderr: '' };
  });
}

describe('detectGithubAuth', () => {
  beforeEach(() => spawnSync.mockReset());

  it('reports none when gh is absent and no token is set', () => {
    stub({ ghOnPath: false });
    expect(detectGithubAuth(false)).toEqual({ ghInstalled: false, ghAuthenticated: false, account: null, tokenSet: false, ready: false, method: 'none' });
  });

  it('reads the gh-authenticated account and prefers the gh method when no token', () => {
    stub({ ghOnPath: true, authStatus: 0, authOutput: '✓ Logged in to github.com account dragocz95 (keyring)\n' });
    const s = detectGithubAuth(false);
    expect(s).toMatchObject({ ghInstalled: true, ghAuthenticated: true, account: 'dragocz95', ready: true, method: 'gh' });
  });

  it('also parses the older "Logged in … as <login>" wording', () => {
    stub({ ghOnPath: true, authStatus: 0, authOutput: '✓ Logged in to github.com as octocat (oauth_token)\n' });
    expect(detectGithubAuth(false).account).toBe('octocat');
  });

  it('is not ready when gh is installed but unauthenticated and no token', () => {
    stub({ ghOnPath: true, authStatus: 1, authOutput: 'You are not logged into any GitHub hosts.\n' });
    expect(detectGithubAuth(false)).toMatchObject({ ghInstalled: true, ghAuthenticated: false, account: null, ready: false, method: 'none' });
  });

  it('a configured token wins: ready via the token method even with no gh login', () => {
    stub({ ghOnPath: false });
    expect(detectGithubAuth(true)).toMatchObject({ tokenSet: true, ready: true, method: 'token' });
  });
});
