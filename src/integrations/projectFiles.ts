import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
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
  // 2) symlink guard — readFileSync/writeFileSync follow symlinks, so re-assert on the real path.
  const real = realOfNearest(forWrite ? dirname(abs) : abs);
  if (real !== r && !real.startsWith(r + sep)) throw new Error('path outside project');
  return abs;
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
