import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
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
    dir = mkdtempSync(join(tmpdir(), 'orca-files-'));
    writeFileSync(join(dir, 'hello.txt'), 'hello world');
  });

  it('registers read/write/edit/list tools', () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual(['edit_file', 'list_dir', 'read_file', 'write_file']);
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
});
