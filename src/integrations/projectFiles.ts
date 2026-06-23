import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, realpathSync, existsSync, rmSync, renameSync, cpSync } from 'node:fs';
import { resolve, join, relative, sep, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Directories never worth showing in a project file tree.
const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', 'coverage', '.cache']);
const MAX_FILE = 2 * 1024 * 1024; // 2 MB — refuse to read/serve anything bigger as text

export interface FileNode { path: string; type: 'file' | 'dir' }

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
function safe(root: string, rel: string, forWrite = false): string {
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
    const abs = safe(root, rel);
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Flat list of a project's files and directories (relative paths), skipping VCS/build dirs. */
export function listProjectFiles(root: string, maxDepth = 8): FileNode[] {
  const r = resolve(root);
  const out: FileNode[] = [];
  const visit = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const abs = join(dir, e.name);
      const rel = relative(r, abs);
      if (e.isDirectory()) {
        out.push({ path: rel, type: 'dir' });
        if (depth < maxDepth) visit(abs, depth + 1);
      } else {
        out.push({ path: rel, type: 'file' });
      }
    }
  };
  visit(r, 0);
  return out;
}

/** Read a project file as UTF-8 text. `truncated` is true (with empty content) when it exceeds the
 *  size cap or isn't a regular file — the editor shows a notice instead of choking on a binary. */
export function readProjectFile(root: string, rel: string): { content: string; truncated: boolean } {
  const abs = safe(root, rel);
  const st = statSync(abs);
  if (!st.isFile() || st.size > MAX_FILE) return { content: '', truncated: true };
  return { content: readFileSync(abs, 'utf8'), truncated: false };
}

/** Overwrite a project file with new UTF-8 content, creating parent dirs as needed. */
export function writeProjectFile(root: string, rel: string, content: string): void {
  const abs = safe(root, rel, true);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

const MAX_RAW = 10 * 1024 * 1024; // 10 MB — cap for raw (binary) reads served to the image preview

/** Read a project file's raw bytes (for binary previews like images). Returns null when it's not a
 *  regular file or exceeds the size cap. Path validated to stay inside the project root. */
export function readProjectBytes(root: string, rel: string): Buffer | null {
  const abs = safe(root, rel);
  const st = statSync(abs);
  if (!st.isFile() || st.size > MAX_RAW) return null;
  return readFileSync(abs);
}

/** Create an empty file inside the project, creating parent dirs as needed. Throws if it exists. */
export function createProjectFile(root: string, rel: string): void {
  const abs = safe(root, rel, true);
  if (existsSync(abs)) throw new Error('already exists');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '', 'utf8');
}

/** Create an empty directory inside the project. Throws if it already exists. */
export function createProjectDir(root: string, rel: string): void {
  const abs = safe(root, rel, true);
  if (existsSync(abs)) throw new Error('already exists');
  mkdirSync(abs, { recursive: true });
}

/** Delete a file or directory (recursively) inside the project. Refuses to delete the project root.
 *  Both the lexical and symlink-resolved paths must stay inside the project. */
export function deleteProjectEntry(root: string, rel: string): void {
  const r = realpathSync(resolve(root));
  const abs = safe(root, rel, true);
  if (abs === r) throw new Error('cannot delete project root');
  rmSync(abs, { recursive: true, force: true });
}

/** Rename/move an entry within the project. Source must exist; target must not. Both validated to
 *  stay inside the project root. */
export function renameProjectEntry(root: string, from: string, to: string): void {
  const src = safe(root, from, true);
  const dst = safe(root, to, true);
  if (!existsSync(src)) throw new Error('source does not exist');
  if (existsSync(dst)) throw new Error('target already exists');
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
}

/** Copy (duplicate) a file or directory within the project. Source must exist; target must not. */
export function copyProjectEntry(root: string, from: string, to: string): void {
  const src = safe(root, from, true);
  const dst = safe(root, to, true);
  if (!existsSync(src)) throw new Error('source does not exist');
  if (existsSync(dst)) throw new Error('target already exists');
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

/** Relative paths of files with uncommitted changes (`git status --porcelain`), so the editor can
 *  highlight them in the tree. Renames report the new path. Empty list on any error / non-repo. */
export async function projectChangedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['-C', realpathSync(resolve(root)), 'status', '--porcelain'], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split('\n')
      .map((line) => line.slice(3).trim())        // strip the 2-char XY status + space
      .filter(Boolean)
      .map((p) => { const a = p.indexOf(' -> '); return a >= 0 ? p.slice(a + 4) : p; }); // rename → new path
  } catch {
    return [];
  }
}

/** Combined working-tree diff vs HEAD (`git diff HEAD`) — all uncommitted tracked changes, for the
 *  "show me what changed" view. Empty string on any error / non-repo. */
export async function projectWorkingDiff(root: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', realpathSync(resolve(root)), 'diff', 'HEAD'], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/** Cap on untracked files rendered into a review diff — bounds the work (and the diff size) when an
 *  agent drops a large new tree; the overseer still sees the change list for the rest. */
const REVIEW_UNTRACKED_LIMIT = 50;

/** Working-tree evidence for an overseer review: the changed-file list (with INDIVIDUAL untracked
 *  files, not just their parent dir) plus a unified diff that ALSO covers brand-new untracked files.
 *  Plain `git diff HEAD` omits untracked files — the common case when an agent creates files — so each
 *  is rendered as a "new file" diff via `git diff --no-index`, which is read-only and never mutates
 *  the index. Empty evidence on a non-repo / git failure. */
export async function projectReviewDiff(root: string): Promise<{ changedFiles: string[]; diff: string }> {
  let cwd: string;
  try { cwd = realpathSync(resolve(root)); } catch { return { changedFiles: [], diff: '' }; }
  const changedFiles: string[] = [];
  try {
    // `-uall` lists every untracked file individually instead of collapsing a new dir to `dir/`.
    const { stdout } = await run('git', ['-C', cwd, 'status', '--porcelain', '-uall'], { maxBuffer: 4 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const p = line.slice(3).trim();              // strip the 2-char XY status + space
      if (!p) continue;
      const a = p.indexOf(' -> ');                 // rename → new path
      changedFiles.push(a >= 0 ? p.slice(a + 4) : p);
    }
  } catch {
    return { changedFiles: [], diff: '' };          // not a git repo / git unavailable
  }
  let diff = '';
  // Tracked, uncommitted changes. HEAD may not exist on a repo with no commits — tolerate that.
  try { diff += (await run('git', ['-C', cwd, 'diff', 'HEAD'], { maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { /* no HEAD yet */ }
  // Untracked files (respecting .gitignore) rendered as new-file additions.
  try {
    const { stdout } = await run('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard'], { maxBuffer: 4 * 1024 * 1024 });
    for (const f of stdout.split('\n').filter(Boolean).slice(0, REVIEW_UNTRACKED_LIMIT)) {
      // `git diff --no-index` exits 1 when the inputs differ (a new file always does), which rejects;
      // the patch is still on the error's stdout. Read it either way — no index mutation.
      try {
        diff += (await run('git', ['-C', cwd, 'diff', '--no-index', '--', '/dev/null', f], { maxBuffer: 8 * 1024 * 1024 })).stdout;
      } catch (e) {
        const out = (e as { stdout?: string }).stdout;
        if (typeof out === 'string') diff += out;
      }
    }
  } catch { /* no untracked files / git unavailable */ }
  return { changedFiles, diff };
}

/** Full diff of a single commit (`git show <hash>`). The hash is validated to be a plain
 *  hex object id so it can never be a git flag/option. Empty string on any error. */
export async function projectCommitDiff(root: string, hash: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return '';
  try {
    const { stdout } = await run('git', ['-C', realpathSync(resolve(root)), 'show', '--stat', '--patch', hash], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/** A file's contents as of HEAD (`git show HEAD:<path>`), for a side-by-side working diff. The path
 *  is validated inside the project and prefixed with `HEAD:` so it can never be a git flag. Empty
 *  string when the file is new/untracked or the repo can't be read. */
export async function projectFileAtHead(root: string, rel: string): Promise<string> {
  const r = realpathSync(resolve(root));
  const cleanRel = relative(r, safe(root, rel));
  try {
    const { stdout } = await run('git', ['-C', r, 'show', `HEAD:${cleanRel}`], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/** Relative paths of files changed in a single commit (`git show --name-only`), so the editor can
 *  highlight them in the tree when browsing that commit. The hash is validated to be a plain hex
 *  object id so it can never be a git flag. Empty list on any error / merge commit. */
export async function projectCommitFiles(root: string, hash: string): Promise<string[]> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return [];
  try {
    const { stdout } = await run('git', ['-C', realpathSync(resolve(root)), 'show', '--name-only', '--pretty=format:', hash], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

interface CommitFileChange { path: string; added: number; deleted: number }
export interface CommitLogEntry { hash: string; subject: string; author: string; timestamp: number; files: CommitFileChange[] }

/** Recent commit history with per-file line churn, for the timeline's "changes over time" view.
 *  One `git log --numstat` call yields each commit's hash, committer timestamp (ms), author, subject
 *  and the list of changed files with +added / −deleted counts (binary files report 0/0). `limit` is
 *  clamped to a sane range so a bogus value can never be trusted or turned into a huge scan. Newest
 *  first; empty list outside a repo or on any error. */
export async function projectCommitLog(root: string, limit: number): Promise<CommitLogEntry[]> {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 30;
  try {
    const { stdout } = await run(
      'git',
      ['-C', realpathSync(resolve(root)), 'log', '-n', String(n), '--numstat', '--pretty=format:\x01%h\x09%ct\x09%an\x09%s'],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const commits: CommitLogEntry[] = [];
    let cur: CommitLogEntry | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('\x01')) {
        const [hash = '', ct = '', author = '', ...rest] = line.slice(1).split('\t');
        cur = { hash, subject: rest.join('\t'), author, timestamp: Number(ct) * 1000, files: [] };
        commits.push(cur);
      } else if (cur && line.trim()) {
        const [added = '', deleted = '', ...pathParts] = line.split('\t');
        const path = pathParts.join('\t').trim();
        if (path) cur.files.push({ path, added: added === '-' ? 0 : Number(added) || 0, deleted: deleted === '-' ? 0 : Number(deleted) || 0 });
      }
    }
    return commits;
  } catch {
    return [];
  }
}

/** Unified diff of a single file as introduced by a commit (`git show <hash> -- <path>`). The hash is
 *  validated as a hex object id; the path is validated to stay inside the project and handed to git
 *  as a clean repo-relative pathspec after `--`. Empty string on any error. */
export async function projectCommitFileDiff(root: string, hash: string, rel: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(hash)) return '';
  const r = realpathSync(resolve(root));
  const cleanRel = relative(r, safe(root, rel));
  try {
    const { stdout } = await run('git', ['-C', r, 'show', '--pretty=format:', hash, '--', cleanRel], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

/** Unified working-tree diff for a single file (`git diff -- <path>`). Empty string when the file
 *  is unchanged or the repo can't be read. Path is validated to stay inside the project and git is
 *  handed a clean repo-relative pathspec after the `--` separator (never a flag). */
export async function projectFileDiff(root: string, rel: string): Promise<string> {
  const r = realpathSync(resolve(root));
  const cleanRel = relative(r, safe(root, rel)); // normalized, inside-root pathspec
  try {
    const { stdout } = await run('git', ['-C', r, 'diff', '--', cleanRel], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}
