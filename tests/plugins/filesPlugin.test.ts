import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('t', params);
};

describe('files plugin', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-'));
    writeFileSync(join(dir, 'hello.txt'), 'hello world');
  });

  it('registers read/write/edit/list tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['edit_file', 'file_info', 'git_status', 'list_dir', 'read_file', 'search_files', 'write_file']);
  });

  it('reads a file inside an allowed root', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'read_file', { path: join(dir, 'hello.txt') }));
    expect(res.content[0].text).toContain('hello world');
  });

  it('writes then reads back inside an allowed root', async () => {
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'write_file', { path: join(dir, 'out.txt'), content: 'written' }));
    expect(readFileSync(join(dir, 'out.txt'), 'utf-8')).toBe('written');
  });

  it('edit_file replaces a unique snippet and returns a numbered diff', async () => {
    const f = join(dir, 'edit.txt');
    writeFileSync(f, 'line one\nline two\nline three');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'edit_file', { path: f, oldText: 'line two', newText: 'line 2' }));
    expect(res.content[0].text).toContain('1 replacement');
    expect(readFileSync(f, 'utf-8')).toBe('line one\nline 2\nline three');
    const diff = (res as { details?: { diff?: string } }).details?.diff ?? '';
    expect(diff).toContain('-    2 line two');
    expect(diff).toContain('+    2 line 2');
  });

  it('edit_file refuses an ambiguous match unless replaceAll is set', async () => {
    const f = join(dir, 'multi.txt');
    writeFileSync(f, 'dup\ndup\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'edit_file', { path: f, oldText: 'dup', newText: 'x' }));
    expect(res.content[0].text).toMatch(/matches 2 times/);
    await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'edit_file', { path: f, oldText: 'dup', newText: 'x', replaceAll: true }));
    expect(readFileSync(f, 'utf-8')).toBe('x\nx\n');
  });

  it('write_file carries a diff for overwrites and new files', async () => {
    const f = join(dir, 'ow.txt');
    writeFileSync(f, 'a\nb\nc');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'write_file', { path: f, content: 'a\nX\nc' }));
    const diff = (res as { details?: { diff?: string } }).details?.diff ?? '';
    expect(diff).toContain('-    2 b');
    expect(diff).toContain('+    2 X');
    const fresh = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'write_file', { path: join(dir, 'new.txt'), content: 'n1\nn2' }));
    const freshDiff = (fresh as { details?: { diff?: string } }).details?.diff ?? '';
    expect(freshDiff).toContain('+    1 n1');
    expect(freshDiff).toContain('+    2 n2');
  });

  it('refuses a path outside the allowed roots', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'read_file', { path: '/etc/hostname' }));
    expect(res.content[0].text).toMatch(/not allowed/);
  });

  it('serializes concurrent writes to the same file (mutation queue)', async () => {
    const f = join(dir, 'race.txt');
    writeFileSync(f, 'zero');
    // FIFO per file: the first-dispatched write lands first, so the second sees it ('one') as its diff
    // baseline instead of the original 'zero' — proving the read-modify-write was serialized, not raced.
    const [, rb] = await runWithPolicy(userPolicy([dir]), () => Promise.all([
      runTool(reg, 'write_file', { path: f, content: 'one' }),
      runTool(reg, 'write_file', { path: f, content: 'two' }),
    ]));
    const diffB = (rb as { details?: { diff?: string } }).details?.diff ?? '';
    expect(diffB).toContain('-    1 one');
    expect(diffB).toContain('+    1 two');
    expect(readFileSync(f, 'utf-8')).toBe('two');
  });

  it('search_files finds content and file names with structured metadata', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'search-target.ts'), 'export const needle = 42;\n');
    writeFileSync(join(dir, 'src', 'search-target.tsx'), 'export const tsxNeedle = 42;\n');
    const content = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'search_files', { path: dir, query: 'needle', include: '*.ts' }));
    expect(content.content[0].text).toContain('search-target.ts');
    expect((content as { details?: { ok?: boolean; matches?: number } }).details?.ok).toBe(true);
    expect((content as { details?: { matches?: number } }).details?.matches).toBeGreaterThan(0);
    const braceGlob = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'search_files', { path: dir, query: 'tsxNeedle', include: '*.{ts,tsx}' }));
    expect(braceGlob.content[0].text).toContain('search-target.tsx');
    const files = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'search_files', { path: dir, query: 'search-target', mode: 'files' }));
    expect(files.content[0].text).toContain('src/search-target.ts');
  });

  it('file_info reports type and byte size', async () => {
    const f = join(dir, 'hello.txt');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'file_info', { path: f }));
    expect(res.content[0].text).toContain('"type": "file"');
    expect((res as { details?: { bytes?: number } }).details?.bytes).toBeGreaterThan(0);
  });

  it('git_status reports branch and dirty files for an allowed repo', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'elowen-files-git-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=a@example.test', '-c', 'user.name=A', 'commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(join(repo, 'tracked.txt'), 'two\n');
    const res = await runWithPolicy(userPolicy([repo]), () => runTool(reg, 'git_status', { path: join(repo, 'tracked.txt') }));
    expect(res.content[0].text).toContain('branch main');
    expect(res.content[0].text).toContain('M tracked.txt');
    expect((res as { details?: { dirtyFiles?: number } }).details?.dirtyFiles).toBe(1);
  });
});

describe('files plugin — configurable readCap', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'elowen-files-cap-')); });

  // shown bytes are everything before the appended "\n…[truncated: …]" hint line.
  const shownLength = (text: string): number => {
    const idx = text.indexOf('\n…[truncated');
    if (idx < 0) throw new Error('not truncated');
    return idx;
  };

  it('a configured readCap (min-clamped 20000) truncates a read that the default 100000 would not', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { readCap: 20_000 } },
    });
    const f = join(dir, 'big1.txt');
    writeFileSync(f, 'a'.repeat(30_000));
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'read_file', { path: f }));
    const text = res.content[0].text;
    expect(text).toContain('…[truncated');
    expect(shownLength(text)).toBe(20_000); // single-line file: byte-slice fallback keeps exactly the cap
  });

  it('unset readCap reproduces the default 100000-byte cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const under = join(dir, 'under.txt');
    writeFileSync(under, 'a'.repeat(30_000));
    const underRes = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'read_file', { path: under }));
    expect(underRes.content[0].text).not.toContain('…[truncated'); // below the 100000 default: untouched

    const over = join(dir, 'over.txt');
    writeFileSync(over, 'a'.repeat(150_000));
    const overRes = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'read_file', { path: over }));
    const text = overRes.content[0].text;
    expect(text).toContain('…[truncated');
    expect(shownLength(text)).toBe(100_000);
  });

  it('truncates line-aware: keeps whole lines within the cap, never a partial line', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { readCap: 20_000 } },
    });
    const f = join(dir, 'lines.txt');
    // 3000 lines of "xxxxxxxxx" (10 bytes incl. newline) => ~30KB, well over the 20KB cap.
    writeFileSync(f, `${Array.from({ length: 3000 }, () => 'x'.repeat(9)).join('\n')}\n`);
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'read_file', { path: f }));
    const text = res.content[0].text;
    expect(text).toContain('…[truncated');
    const shown = text.slice(0, shownLength(text));
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(20_000); // within cap
    expect(shown.split('\n').every((l) => l === 'x'.repeat(9))).toBe(true); // only whole lines kept
  });
});

describe('files plugin — configurable searchMaxMatches', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'elowen-files-search-cap-'));
    const lines = Array.from({ length: 250 }, (_, i) => `needle line ${i}`).join('\n');
    writeFileSync(join(dir, 'haystack.txt'), lines);
  });

  it('a configured searchMaxMatches (min-clamped 50) truncates results sooner than the default 200', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log,
      config: { files: { searchMaxMatches: 50 } },
    });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'search_files', { path: dir, query: 'needle' }));
    expect((res as { details?: { matches?: number } }).details?.matches).toBe(50);
    expect((res as { details?: { truncated?: boolean } }).details?.truncated).toBe(true);
  });

  it('unset searchMaxMatches reproduces the default 200-match cap exactly', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'search_files', { path: dir, query: 'needle' }));
    expect((res as { details?: { matches?: number } }).details?.matches).toBe(200);
    expect((res as { details?: { truncated?: boolean } }).details?.truncated).toBe(true);
  });
});
