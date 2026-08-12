import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, realpathSync, existsSync, rmSync, renameSync, cpSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IGNORE = new Set(['.git', 'node_modules', '.next', 'dist', '.turbo', 'coverage', '.cache']);
const MAX_FILE = 2 * 1024 * 1024;
const MAX_RAW = 10 * 1024 * 1024;

export interface FileNode { path: string; type: 'file' | 'dir' }
export type SafePath = (root: string, rel: string, forWrite?: boolean) => string;

export function listProjectFiles(root: string, maxDepth = 8): FileNode[] {
  const resolvedRoot = realpathSync(root);
  const out: FileNode[] = [];
  const visit = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const path = relative(resolvedRoot, abs);
      if (entry.isDirectory()) {
        out.push({ path, type: 'dir' });
        if (depth < maxDepth) visit(abs, depth + 1);
      } else out.push({ path, type: 'file' });
    }
  };
  visit(resolvedRoot, 0);
  return out;
}

export function readProjectFile(safe: SafePath, root: string, rel: string): { content: string; truncated: boolean } {
  const abs = safe(root, rel);
  const stat = statSync(abs);
  if (!stat.isFile() || stat.size > MAX_FILE) return { content: '', truncated: true };
  return { content: readFileSync(abs, 'utf8'), truncated: false };
}

export function writeProjectFile(safe: SafePath, root: string, rel: string, content: string): void {
  const abs = safe(root, rel, true);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

export function readProjectBytes(safe: SafePath, root: string, rel: string): Buffer | null {
  const abs = safe(root, rel);
  const stat = statSync(abs);
  return !stat.isFile() || stat.size > MAX_RAW ? null : readFileSync(abs);
}

export function createProjectFile(safe: SafePath, root: string, rel: string): void {
  const abs = safe(root, rel, true);
  if (existsSync(abs)) throw new Error('already exists');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, '', 'utf8');
}

export function createProjectDir(safe: SafePath, root: string, rel: string): void {
  const abs = safe(root, rel, true);
  if (existsSync(abs)) throw new Error('already exists');
  mkdirSync(abs, { recursive: true });
}

export function deleteProjectEntry(safe: SafePath, root: string, rel: string): void {
  const projectRoot = realpathSync(root);
  const abs = safe(root, rel, true);
  if (abs === projectRoot) throw new Error('cannot delete project root');
  rmSync(abs, { recursive: true, force: true });
}

export function renameProjectEntry(safe: SafePath, root: string, from: string, to: string): void {
  const src = safe(root, from, true);
  const dst = safe(root, to, true);
  if (!existsSync(src)) throw new Error('source does not exist');
  if (existsSync(dst)) throw new Error('target already exists');
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
}

export function copyProjectEntry(safe: SafePath, root: string, from: string, to: string): void {
  const src = safe(root, from, true);
  const dst = safe(root, to, true);
  if (!existsSync(src)) throw new Error('source does not exist');
  if (existsSync(dst)) throw new Error('target already exists');
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

const gitRoot = (root: string) => realpathSync(root);
export async function projectChangedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await run('git', ['-C', gitRoot(root), 'status', '--porcelain'], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean).map((path) => { const at = path.indexOf(' -> '); return at >= 0 ? path.slice(at + 4) : path; });
  } catch { return []; }
}
export async function projectWorkingDiff(root: string): Promise<string> {
  try { return (await run('git', ['-C', gitRoot(root), 'diff', 'HEAD'], { maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { return ''; }
}
export async function projectFileAtHead(safe: SafePath, root: string, rel: string): Promise<string> {
  const resolvedRoot = gitRoot(root);
  const clean = relative(resolvedRoot, safe(root, rel));
  try { return (await run('git', ['-C', resolvedRoot, 'show', `HEAD:${clean}`], { maxBuffer: 4 * 1024 * 1024 })).stdout; } catch { return ''; }
}
export async function projectFileDiff(safe: SafePath, root: string, rel: string): Promise<string> {
  const resolvedRoot = gitRoot(root);
  const clean = relative(resolvedRoot, safe(root, rel));
  try { return (await run('git', ['-C', resolvedRoot, 'diff', '--', clean], { maxBuffer: 4 * 1024 * 1024 })).stdout; } catch { return ''; }
}
const isGitSha = (value: string) => /^[0-9a-f]{7,64}$/i.test(value);
export async function projectCommitDiff(root: string, hash: string): Promise<string> {
  if (!isGitSha(hash)) return '';
  try { return (await run('git', ['-C', gitRoot(root), 'show', '--stat', '--patch', hash], { maxBuffer: 8 * 1024 * 1024 })).stdout; } catch { return ''; }
}
export async function projectCommitFiles(root: string, hash: string): Promise<string[]> {
  if (!isGitSha(hash)) return [];
  try { return (await run('git', ['-C', gitRoot(root), 'show', '--name-only', '--pretty=format:', hash], { maxBuffer: 4 * 1024 * 1024 })).stdout.split('\n').map((line) => line.trim()).filter(Boolean); } catch { return []; }
}
export async function projectCommitFileDiff(safe: SafePath, root: string, hash: string, rel: string): Promise<string> {
  if (!isGitSha(hash)) return '';
  const resolvedRoot = gitRoot(root);
  const clean = relative(resolvedRoot, safe(root, rel));
  try { return (await run('git', ['-C', resolvedRoot, 'show', '--pretty=format:', hash, '--', clean], { maxBuffer: 4 * 1024 * 1024 })).stdout; } catch { return ''; }
}
export async function projectCommitLog(root: string, limit: number): Promise<{ hash: string; subject: string; author: string; timestamp: number; files: { path: string; added: number; deleted: number }[] }[]> {
  const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 30;
  try {
    const { stdout } = await run('git', ['-C', gitRoot(root), 'log', '-n', String(n), '--numstat', '--pretty=format:\x01%h\x09%ct\x09%an\x09%s'], { maxBuffer: 8 * 1024 * 1024 });
    const commits: { hash: string; subject: string; author: string; timestamp: number; files: { path: string; added: number; deleted: number }[] }[] = [];
    let current: typeof commits[number] | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('\x01')) { const [hash = '', ts = '', author = '', ...subject] = line.slice(1).split('\t'); current = { hash, author, subject: subject.join('\t'), timestamp: Number(ts) * 1000, files: [] }; commits.push(current); }
      else if (current && line.trim()) { const [added = '', deleted = '', ...path] = line.split('\t'); const joined = path.join('\t').trim(); if (joined) current.files.push({ path: joined, added: added === '-' ? 0 : Number(added) || 0, deleted: deleted === '-' ? 0 : Number(deleted) || 0 }); }
    }
    return commits;
  } catch { return []; }
}
