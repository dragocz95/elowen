import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, sep, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Directories never worth showing in a project file tree.
const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', 'coverage', '.cache']);
const MAX_FILE = 2 * 1024 * 1024; // 2 MB — refuse to read/serve anything bigger as text

export interface FileNode { path: string; type: 'file' | 'dir' }

/** Resolve `rel` strictly inside `root`. Throws on any path that escapes the project (the guard
 *  against `../` traversal and absolute paths reaching outside the repo). */
function safe(root: string, rel: string): string {
  const r = resolve(root);
  const abs = resolve(r, rel);
  if (abs !== r && !abs.startsWith(r + sep)) throw new Error('path outside project');
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
  const abs = safe(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/** Unified working-tree diff for a single file (`git diff -- <path>`). Empty string when the file
 *  is unchanged or the repo can't be read. Path is validated to stay inside the project. */
export async function projectFileDiff(root: string, rel: string): Promise<string> {
  safe(root, rel); // validate, even though git is given the path explicitly
  try {
    const { stdout } = await run('git', ['-C', resolve(root), 'diff', '--', rel], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}
