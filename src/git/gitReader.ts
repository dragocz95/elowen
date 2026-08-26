import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export interface GitRemote { name: string; fetchUrl: string; pushUrl: string }
export interface GitStatus {
  branch: string;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: number;
  untracked: number;
  clean: boolean;
}
export interface GitBranch { name: string; current: boolean }
export interface GitCommit { hash: string; subject: string; author: string; relative: string }
export interface ProjectGitSnapshot { isRepo: boolean; status: GitStatus | null; remotes: GitRemote[] }
export interface ProjectGit extends ProjectGitSnapshot { branches: GitBranch[]; commits: GitCommit[] }
export interface GitReader {
  snapshot(path: string): Promise<ProjectGitSnapshot>;
  read(path: string): Promise<ProjectGit>;
}

const EMPTY_SNAPSHOT: ProjectGitSnapshot = { isRepo: false, status: null, remotes: [] };
const EMPTY: ProjectGit = { ...EMPTY_SNAPSHOT, branches: [], commits: [] };

export class RealGitReader implements GitReader {
  async snapshot(path: string): Promise<ProjectGitSnapshot> {
    try { await run('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']); }
    catch { return EMPTY_SNAPSHOT; }
    const [status, remotes] = await Promise.all([this.status(path), this.remotes(path)]);
    return { isRepo: true, status, remotes };
  }

  async read(path: string): Promise<ProjectGit> {
    const snapshot = await this.snapshot(path);
    if (!snapshot.isRepo) return EMPTY;
    const [branches, commits] = await Promise.all([this.branches(path), this.commits(path)]);
    return { ...snapshot, branches, commits };
  }

  private async status(path: string): Promise<GitStatus | null> {
    try {
      const { stdout } = await run('git', ['-C', path, 'status', '--porcelain=v2', '--branch'], { maxBuffer: 1024 * 1024 });
      const lines = stdout.split('\n');
      let branch = 'HEAD';
      let head = '';
      let upstream: string | null = null;
      let ahead = 0;
      let behind = 0;
      let dirty = 0;
      let untracked = 0;
      for (const line of lines) {
        if (line.startsWith('# branch.oid ')) head = line.slice('# branch.oid '.length).trim() === '(initial)' ? '' : line.slice('# branch.oid '.length).trim();
        else if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
        else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim() || null;
        else if (line.startsWith('# branch.ab ')) {
          const match = line.match(/\+(\d+)\s+-(\d+)/);
          if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
        } else if (line.startsWith('? ')) untracked += 1;
        else if (line && !line.startsWith('#') && !line.startsWith('! ')) dirty += 1;
      }
      return { branch, head, upstream, ahead, behind, dirty, untracked, clean: dirty === 0 && untracked === 0 };
    } catch { return null; }
  }

  private async remotes(path: string): Promise<GitRemote[]> {
    try {
      const { stdout } = await run('git', ['-C', path, 'remote'], { maxBuffer: 1024 * 1024 });
      const names = stdout.split('\n').map((name) => name.trim()).filter(Boolean);
      return Promise.all(names.map(async (name) => {
        const [fetchUrl, pushUrl] = await Promise.all([
          this.remoteUrl(path, name, false),
          this.remoteUrl(path, name, true),
        ]);
        return { name, fetchUrl: sanitizeRemoteUrl(fetchUrl), pushUrl: sanitizeRemoteUrl(pushUrl || fetchUrl) };
      }));
    } catch { return []; }
  }

  private async remoteUrl(path: string, name: string, push: boolean): Promise<string> {
    try {
      const { stdout } = await run('git', ['-C', path, 'remote', 'get-url', ...(push ? ['--push'] : []), name], { maxBuffer: 1024 * 1024 });
      return stdout.trim();
    } catch { return ''; }
  }

  private async branches(path: string): Promise<GitBranch[]> {
    try {
      const { stdout } = await run('git', ['-C', path, 'branch', '--format=%(HEAD)%09%(refname:short)'], { maxBuffer: 1024 * 1024 });
      return stdout.split('\n').filter(Boolean).map((line) => {
        const [head, name] = line.split('\t');
        return { name: name ?? line.trim(), current: head === '*' };
      });
    } catch { return []; }
  }

  private async commits(path: string): Promise<GitCommit[]> {
    try {
      const { stdout } = await run('git', ['-C', path, 'log', '-n', '15', '--pretty=format:%h%x09%s%x09%an%x09%cr'], { maxBuffer: 1024 * 1024 });
      return stdout.split('\n').filter(Boolean).map((line) => {
        const [hash = '', subject = '', author = '', relative = ''] = line.split('\t');
        return { hash, subject, author, relative };
      });
    } catch { return []; }
  }
}

export class FakeGitReader implements GitReader {
  constructor(private result: ProjectGit) {}
  async snapshot(): Promise<ProjectGitSnapshot> {
    const { branches: _branches, commits: _commits, ...snapshot } = this.result;
    return snapshot;
  }
  async read(): Promise<ProjectGit> { return this.result; }
}

export function sanitizeRemoteUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    return url.toString();
  } catch {
    // SCP-style SSH remotes (`git@github.com:owner/repo.git`) carry an SSH user, not an embedded
    // password/token, and remain useful for generic remote detection. Unknown non-URL forms are returned
    // verbatim because inventing a rewritten transport string would be less safe than preserving it.
    return value;
  }
}
