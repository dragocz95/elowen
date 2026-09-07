import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

// Parity with the reference file tools: the wording the model is trained on, and the guards that wording
// promises. Each case here corresponds to one item of the tool-parity backlog.

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginEntry = pathToFileURL(join(repoRoot, 'plugins/files/index.mjs')).href;
const userPolicy = (roots: string[]): Policy => ({ allowedProjectIds: new Set([1]), allowedPaths: () => roots });

const runTool = (reg: PluginRegistry, name: string, params: Record<string, unknown>) => {
  const tool = reg.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> }).execute('t', params);
};
const textOf = (res: { content: { text: string }[] }) => res.content[0].text;
const detailsOf = (res: unknown) => (res as { details?: Record<string, unknown> }).details ?? {};
const descriptionOf = (reg: PluginRegistry, name: string) =>
  (reg.tools.find((t) => t.name === name) as unknown as { description: string }).description;

describe('files plugin — reference wording', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-parity-text-'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('Grep explains the ripgrep brace escaping and why it must not be run through Bash', () => {
    const description = descriptionOf(reg, 'Grep');
    expect(description).toContain('The Grep tool has been optimized for correct permissions and access.');
    expect(description).toContain('literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)');
  });

  it('Edit warns never to carry the line number prefix into old_string or new_string', () => {
    const description = descriptionOf(reg, 'Edit');
    expect(description).toContain('as it appears AFTER the line number prefix');
    expect(description).toContain('The line number prefix format is: line number + tab.');
    expect(description).toContain('Never include any part of the line number prefix in the old_string or new_string.');
  });

  it('Write reports a creation and an overwrite in the two reference sentences', async () => {
    const path = join(dir, 'created.txt');
    const created = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { file_path: path, content: 'one' }));
    expect(textOf(created)).toBe(`File created successfully at: ${path}`);

    const updated = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Write', { file_path: path, content: 'two' }));
    expect(textOf(updated)).toBe(`The file ${path} has been updated successfully.`);
  });

  it('Glob and Grep report an empty result the way the reference does, per mode', async () => {
    writeFileSync(join(dir, 'present.txt'), 'body\n');
    const glob = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Glob', { path: dir, pattern: '*.nothing' }));
    expect(textOf(glob)).toBe('No files found');

    const content = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: dir, pattern: 'zzz-absent' }));
    expect(textOf(content)).toBe('No matches found');
    const counted = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: dir, pattern: 'zzz-absent', output_mode: 'count' }));
    expect(textOf(counted)).toBe('No matches found');
    const files = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: dir, pattern: 'zzz-absent', output_mode: 'files_with_matches' }));
    expect(textOf(files)).toBe('No files found');
  });
});

describe('files plugin — Read guards', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-parity-read-'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('refuses a binary file by extension instead of streaming it as lossy text', async () => {
    const path = join(dir, 'module.wasm');
    // Valid UTF-8 so nothing else in the pipeline would object — only the extension says it is binary.
    writeFileSync(path, 'asm-ish text that would otherwise be returned verbatim\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: path }));
    expect(detailsOf(res).ok).toBe(false);
    expect(textOf(res)).toContain('This tool cannot read binary files. The file appears to be a binary .wasm file.');
    expect(textOf(res)).not.toContain('asm-ish text');
  });

  it('refuses a device file that would block or never reach EOF', async () => {
    const res = await runWithPolicy(userPolicy(['/dev']), () => runTool(reg, 'Read', { file_path: '/dev/zero' }));
    expect(detailsOf(res).ok).toBe(false);
    expect(textOf(res)).toContain('this device file would block or produce infinite output.');
  });

  it('refuses a page whose tokens exceed the read budget even when its bytes do not', async () => {
    // Dense JSON: ~90 KB is comfortably under the 97.7 KB byte cap, but costs about two bytes per token,
    // so it is roughly 45 000 tokens — far past the budget the byte cap cannot express.
    const path = join(dir, 'dense.json');
    writeFileSync(path, `[${Array.from({ length: 4500 }, (_, i) => `{"k":${i},"v":"${i}"}`).join(',')}]\n`);
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: path }));
    expect(detailsOf(res).ok).toBe(false);
    expect(textOf(res)).toMatch(/exceeds maximum allowed tokens \(25000\)/);
    expect(textOf(res)).toContain('Use offset and limit parameters to read specific portions of the file');
  });

  it('names the cwd and a same-stem neighbour when the file is not there', async () => {
    writeFileSync(join(dir, 'config.json'), '{}\n');
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Read', { file_path: join(dir, 'config.yaml') }));
    expect(detailsOf(res).ok).toBe(false);
    expect(textOf(res)).toContain('File does not exist.');
    expect(textOf(res)).toContain('Note: your current working directory is');
    expect(textOf(res)).toContain(`Did you mean ${join(dir, 'config.json')}?`);
  });
});

describe('files plugin — Edit size cap', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-parity-edit-'));
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('refuses a file over 1 GB before reading it into memory', async () => {
    const path = join(dir, 'huge.txt');
    writeFileSync(path, 'needle\n');
    truncateSync(path, 1024 ** 3 + 1); // sparse: no bytes are actually written to disk
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Edit', { file_path: path, old_string: 'needle', new_string: 'thread' }));
    expect(detailsOf(res).ok).toBe(false);
    expect(textOf(res)).toContain('Maximum editable file size is 1 GB.');
    expect(textOf(res)).toContain('File is too large to edit');
  });
});

describe('files plugin — Glob and Grep reach', () => {
  let reg: PluginRegistry;
  let dir: string;
  beforeAll(async () => {
    reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['files'], logger: log });
    dir = mkdtempSync(join(tmpdir(), 'elowen-parity-search-'));
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'const needle = 1;\nconst second = 2;\nconst third = 3;\n');
    writeFileSync(join(dir, 'src', 'deep', 'b.ts'), 'export const needle = 2;\n');
    writeFileSync(join(dir, 'src', 'c.js'), 'const needle = 3;\n');
    writeFileSync(join(dir, 'src', 'd.md'), 'needle in markdown\n');
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: needle pipeline\n');
  });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('resolves an absolute glob pattern to the same set as its path plus relative form', async () => {
    const absolute = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Glob', { pattern: `${join(dir, 'src')}/**/*.ts` }));
    const relative = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Glob', { path: join(dir, 'src'), pattern: '**/*.ts' }));
    expect(textOf(absolute).split('\n').sort()).toEqual(['a.ts', 'deep/b.ts']);
    expect(textOf(absolute).split('\n').sort()).toEqual(textOf(relative).split('\n').sort());
  });

  it('filters on every pattern in a comma-separated glob list', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(
      reg, 'Grep', { path: dir, pattern: 'needle', glob: '*.js,*.ts', output_mode: 'files_with_matches' },
    ));
    const rows = textOf(res).split('\n').sort();
    expect(rows).toEqual(['src/a.ts', 'src/c.js', 'src/deep/b.ts']);
    expect(textOf(res)).not.toContain('d.md');
  });

  it('searches hidden directories that ripgrep would skip by default', async () => {
    const res = await runWithPolicy(userPolicy([dir]), () => runTool(
      reg, 'Grep', { path: dir, pattern: 'needle pipeline', output_mode: 'files_with_matches' },
    ));
    expect(textOf(res)).toContain('.github/workflows/ci.yml');
  });

  it('accepts context as an alias of -C and drops line numbers with -n false', async () => {
    const target = join(dir, 'src', 'a.ts');
    const viaContext = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: target, pattern: 'needle', context: 2 }));
    const viaDash = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: target, pattern: 'needle', '-C': 2 }));
    expect(textOf(viaContext)).toBe(textOf(viaDash));
    expect(textOf(viaContext)).toContain('third');

    const numbered = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: target, pattern: 'needle' }));
    expect(textOf(numbered)).toBe('a.ts:1:const needle = 1;');
    const unnumbered = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: target, pattern: 'needle', '-n': false }));
    expect(textOf(unnumbered)).toBe('a.ts:const needle = 1;');
  });

  it('names the cwd and a neighbour when a Grep or Glob path is not there', async () => {
    const grep = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Grep', { path: join(dir, 'srcs'), pattern: 'needle' }));
    expect(detailsOf(grep).ok).toBe(false);
    expect(textOf(grep)).toContain(`Path does not exist: ${join(dir, 'srcs')}.`);
    expect(textOf(grep)).toContain('Note: your current working directory is');

    const glob = await runWithPolicy(userPolicy([dir]), () => runTool(reg, 'Glob', { path: join(dir, 'src', 'a.tsx'), pattern: '*' }));
    expect(detailsOf(glob).ok).toBe(false);
    expect(textOf(glob)).toContain(`Directory does not exist: ${join(dir, 'src', 'a.tsx')}.`);
    expect(textOf(glob)).toContain(`Did you mean ${join(dir, 'src', 'a.ts')}?`);
  });
});

describe('files plugin — search helpers', () => {
  let dirs: string[] = [];
  afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

  it('reports a killed ripgrep as a timeout naming the bound and what to narrow', async () => {
    const { grepTimeoutError } = await import(pluginEntry) as {
      grepTimeoutError: (error: unknown) => Error | null;
    };
    const killed = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });
    const message = grepTimeoutError(killed)?.message ?? '';
    expect(message).toContain('Search timed out after 5 seconds.');
    expect(message).toContain('The search may have matched files but did not complete in time.');
    expect(message).toContain('Try searching a more specific path or pattern.');
    // An ordinary rg failure keeps its own error: only a kill is a timeout.
    expect(grepTimeoutError(Object.assign(new Error('rg: bad pattern'), { code: 2 }))).toBeNull();
  });

  it('splits a glob value on whitespace and commas but keeps a brace group whole', async () => {
    const { splitGlobPatterns } = await import(pluginEntry) as { splitGlobPatterns: (v: string) => string[] };
    expect(splitGlobPatterns('*.js,*.ts')).toEqual(['*.js', '*.ts']);
    expect(splitGlobPatterns('*.js *.ts')).toEqual(['*.js', '*.ts']);
    expect(splitGlobPatterns('*.{ts,tsx}')).toEqual(['*.{ts,tsx}']);
    expect(splitGlobPatterns('')).toEqual([]);
  });
});
