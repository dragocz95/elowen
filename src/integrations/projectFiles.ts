import { statSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitFileChange, CommitLogEntry } from '../shared/wireContract.js';
import { isGitSha } from '../shared/gitSha.js';

// The commit-row shapes are the daemon↔web wire contract (git log / task change-list endpoints) —
// defined once in src/shared and re-exported here, so the two can never drift.
export type { CommitFileChange, CommitLogEntry };

const run = promisify(execFile);

// Directories never worth showing in a project file tree.
const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', 'coverage', '.cache']);
/** realpath of the nearest existing ancestor of `p` — lets us validate a not-yet-created file by
 *  resolving the deepest directory that does exist. */
function realOfNearest(p: string): string {
  let cur = p;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { return realpathSync(cur); }
    catch { const parent = dirname(cur); if (parent === cur) return cur; cur = parent; }
  }
}

/** Resolve `rel` strictly inside `root`. Guards against `../` traversal AND symlink escape: the
 *  lexical path must stay inside the project, and the real (symlink-followed) path must too — for a
 *  write, the real path of the deepest existing parent dir. Throws otherwise. */
export function safeProjectPath(root: string, rel: string, forWrite = false): string {
  const r = realpathSync(resolve(root));
  const abs = resolve(r, rel);
  // 1) lexical guard (cheap; also covers non-existent paths and absolute escapes)
  if (abs !== r && !abs.startsWith(r + sep)) throw new Error('path outside project');
  // 2) symlink guard — read/write follow symlinks, so re-assert on the real path. For a write we
  //    must resolve the leaf when it ALREADY exists (an existing leaf symlink would otherwise be
  //    followed outside on overwrite); only fall back to the parent dir when the file is new.
  const real = realOfNearest(forWrite && !existsSync(abs) ? dirname(abs) : abs);
  if (real !== r && !real.startsWith(r + sep)) throw new Error('path outside project');
  return abs;
}

// Image extensions a project icon may point at. Matches what `/raw` serves and what the picker shows.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);

/** True when `rel` resolves to a regular image file strictly inside the project root — used to validate
 *  a chosen project icon before persisting it. Never throws: a traversal/symlink escape, a missing
 *  file, a directory or a non-image extension all return false. */
export function isProjectImage(root: string, rel: string): boolean {
  if (!IMAGE_EXT.has((rel.split('.').pop() ?? '').toLowerCase())) return false;
  try {
    const abs = safeProjectPath(root, rel);
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

export interface DirListing { path: string; parent: string | null; entries: { name: string; path: string }[] }

/** Shallow-list the sub-directories of an absolute server path — backs the new-project directory picker
 *  (you can't list a project's files before the project exists). Returns the resolved path, its parent
 *  (null at the filesystem root) and the immediate child directories, sorted, with the usual build noise
 *  (`.git`, `node_modules`, …) filtered out. Throws when the path isn't a readable directory, which the
 *  route turns into a 400. Read-only and directory-only: never exposes file contents. */
export function listDirs(input: string): DirListing {
  const path = realpathSync(resolve(input || '/'));
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !IGNORE.has(d.name))
    .map((d) => ({ name: d.name, path: join(path, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}

/** Parse one git --numstat row into a file change. */
function parseNumstatLine(line: string): CommitFileChange | null {
  const [added = '', deleted = '', ...pathParts] = line.split('\t');
  const path = pathParts.join('\t').trim();
  if (!path) return null;
  return { path, added: added === '-' ? 0 : Number(added) || 0, deleted: deleted === '-' ? 0 : Number(deleted) || 0 };
}

/** Parse the shared git-log numstat wire format used by project range history. */
function parseCommitLog(stdout: string): CommitLogEntry[] {
  const commits: CommitLogEntry[] = [];
  let cur: CommitLogEntry | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\x01')) {
      const [hash = '', ct = '', author = '', ...rest] = line.slice(1).split('\t');
      cur = { hash, subject: rest.join('\t'), author, timestamp: Number(ct) * 1000, files: [] };
      commits.push(cur);
    } else if (cur && line.trim()) {
      const file = parseNumstatLine(line);
      if (file) cur.files.push(file);
    }
  }
  return commits;
}

/** Unified diff of a single file as introduced by a commit (`git show <hash> -- <path>`). The hash is
 *  validated as a hex object id; the path is validated to stay inside the project and handed to git
 *  as a clean repo-relative pathspec after `--`. Empty string on any error. */
export async function projectCommitFileDiff(root: string, hash: string, rel: string): Promise<string> {
  if (!isGitSha(hash)) return '';
  const r = realpathSync(resolve(root));
  const cleanRel = relative(r, safeProjectPath(root, rel));
  try {
    const { stdout } = await run('git', ['-C', r, 'show', '--pretty=format:', hash, '--', cleanRel], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}


/** The commits a task landed, as `git log base..head --numstat` in its checkout — the per-commit
 *  history behind a task's frozen change list. `base`/`head` are the SHAs stamped at spawn/snapshot.
 *  Newest first; empty list on a bad range, a non-repo, or any git error. */
export async function projectRangeLog(root: string, base: string, head: string): Promise<CommitLogEntry[]> {
  if (!isGitSha(base) || !isGitSha(head)) return [];
  try {
    const { stdout } = await run(
      'git',
      ['-C', realpathSync(resolve(root)), 'log', '--numstat', '--pretty=format:\x01%h\x09%ct\x09%an\x09%s', `${base}..${head}`],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return parseCommitLog(stdout);
  } catch {
    return [];
  }
}

/** The project's current git HEAD sha (`git rev-parse HEAD`), captured as a task's baseline at spawn.
 *  Empty string outside a repo / on any error (e.g. a repo with no commits yet). */
export async function projectHead(root: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', realpathSync(resolve(root)), 'rev-parse', 'HEAD'], { maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Per-file line churn between two commits (`git diff --numstat <base> <head>`) — the frozen delta a
 *  task introduced, captured at close. Both refs are validated as hex object ids so neither can be a
 *  git flag. Newly-committed files appear in the range (no `--no-index` needed). Empty list outside a
 *  repo, on any error, or when the range is empty (base === head). */
export async function projectRangeDiff(root: string, base: string, head: string): Promise<CommitFileChange[]> {
  if (!isGitSha(base) || !isGitSha(head)) return [];
  try {
    const { stdout } = await run('git', ['-C', realpathSync(resolve(root)), 'diff', '--numstat', base, head], { maxBuffer: 8 * 1024 * 1024 });
    const files: CommitFileChange[] = [];
    for (const line of stdout.split('\n')) {
      const f = parseNumstatLine(line);
      if (f) files.push(f);
    }
    return files;
  } catch {
    return [];
  }
}

/** Unified diff of a single file across a commit range (`git diff <base> <head> -- <path>`), for the
 *  click-through on a task's frozen change list. Both refs are validated as hex object ids; the path is
 *  validated to stay inside the project and handed to git as a clean pathspec after `--`. Empty string
 *  on a non-hex ref or any error (e.g. a ref GC'd after a later squash) — the list still renders. */
export async function projectRangeFileDiff(root: string, base: string, head: string, rel: string): Promise<string> {
  if (!isGitSha(base) || !isGitSha(head)) return '';
  const r = realpathSync(resolve(root));
  const cleanRel = relative(r, safeProjectPath(root, rel));
  try {
    const { stdout } = await run('git', ['-C', r, 'diff', base, head, '--', cleanRel], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}
