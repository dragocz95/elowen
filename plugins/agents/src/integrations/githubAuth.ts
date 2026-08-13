import { spawnSync } from 'node:child_process';

/** The GitHub auth posture the daemon will actually use when a PR-native mission pushes and opens a PR.
 *  `method` is the effective path: a configured token wins (injected as an auth header), otherwise gh's
 *  own login (credential helper), otherwise nothing. `ready` is the single signal the UI/wizard gate on. */
export interface GithubAuthStatus {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  /** The gh-authenticated account login, when it can be parsed from `gh auth status`. */
  account: string | null;
  tokenSet: boolean;
  ready: boolean;
  method: 'token' | 'gh' | 'none';
}

/** Pull the logged-in account out of `gh auth status` output, tolerant of gh version wording
 *  ("… account <login>" on newer gh, "… as <login>" on older). Returns null when absent. */
function parseGhAccount(output: string): string | null {
  const m = output.match(/Logged in to \S+ (?:account|as) (\S+)/);
  return m ? (m[1] ?? null) : null;
}

/** Probe the local GitHub auth posture. `tokenSet` is whether an Elowen-stored token exists (its value is
 *  never needed here). Runs as the daemon's service user, so it reflects exactly what a push would use.
 *  Pure of config: detection only — callers combine it with `ready`/`method` to drive UX. */
export function detectGithubAuth(tokenSet: boolean): GithubAuthStatus {
  let ghInstalled = false;
  let ghAuthenticated = false;
  let account: string | null = null;

  if (spawnSync('which', ['gh'], { timeout: 5000 }).status === 0) {
    ghInstalled = true;
    const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 5000 });
    ghAuthenticated = r.status === 0;
    account = parseGhAccount((r.stdout ?? '') + (r.stderr ?? ''));
  }

  const method: GithubAuthStatus['method'] = tokenSet ? 'token' : ghAuthenticated ? 'gh' : 'none';
  return { ghInstalled, ghAuthenticated, account, tokenSet, ready: tokenSet || ghAuthenticated, method };
}
