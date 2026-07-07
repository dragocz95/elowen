import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginHook } from '../../src/plugins/api.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

interface FormatterEntry { name: string; command: string[]; extensions: string[]; enabledWhen: (dir: string) => boolean }
interface FormattersModule {
  FORMATTERS: FormatterEntry[];
  resolveFormatter: (filePath: string, projectDir: string, disabled?: Set<string>) => FormatterEntry | null;
  buildCommand: (formatter: FormatterEntry, projectDir: string, filePath: string) => string[];
}

/** Drop an executable fake binary (shell script) at `path`. */
const fakeBin = (path: string, body = '#!/bin/sh\nexit 0\n') => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
};

/** A temp project with a fake local prettier that marks each formatted file with `<file>.formatted`. */
const projectWithPrettier = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-'));
  fakeBin(join(dir, 'node_modules/.bin/prettier'), '#!/bin/sh\necho formatted > "$2.formatted"\n');
  return dir;
};

const writeResult = (path: string) => ({ tool: 'write_file', params: { path }, result: { content: [], details: { ok: true, path } } });

describe('formatters plugin — catalog resolution (extension → formatter, enabledWhen gates)', () => {
  let mod: FormattersModule;
  beforeAll(async () => { mod = await import(join(pluginsDir, 'formatters/index.mjs')) as FormattersModule; });

  it('resolves by extension only when the project gate passes (local prettier bin)', () => {
    const dir = projectWithPrettier();
    expect(mod.resolveFormatter(join(dir, 'a.ts'), dir)?.name).toBe('prettier');
    expect(mod.resolveFormatter(join(dir, 'notes.md'), dir)?.name).toBe('prettier');
    expect(mod.resolveFormatter(join(dir, 'x.php'), dir)).toBeNull(); // no vendor/bin/pint
    expect(mod.resolveFormatter(join(dir, 'x.unknown'), dir)).toBeNull();
    expect(mod.resolveFormatter(join(dir, 'Makefile'), dir)).toBeNull(); // no extension
  });

  it('an empty project enables nothing, even for known extensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-empty-'));
    expect(mod.resolveFormatter(join(dir, 'a.ts'), dir)).toBeNull();
    expect(mod.resolveFormatter(join(dir, 'a.go'), dir)).toBeNull();
  });

  it('pint is gated on vendor/bin/pint being present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-php-'));
    expect(mod.resolveFormatter(join(dir, 'x.php'), dir)).toBeNull();
    fakeBin(join(dir, 'vendor/bin/pint'));
    expect(mod.resolveFormatter(join(dir, 'x.php'), dir)?.name).toBe('pint');
  });

  it('an explicit biome config wins over a merely present prettier bin (catalog order)', () => {
    const dir = projectWithPrettier();
    fakeBin(join(dir, 'node_modules/.bin/biome'));
    writeFileSync(join(dir, 'biome.json'), '{}');
    expect(mod.resolveFormatter(join(dir, 'a.ts'), dir)?.name).toBe('biome');
  });

  it('a disabled formatter is skipped', () => {
    const dir = projectWithPrettier();
    expect(mod.resolveFormatter(join(dir, 'a.ts'), dir, new Set(['prettier']))).toBeNull();
  });

  it('buildCommand substitutes $FILE and falls back to the PATH binary when the local bin is absent', () => {
    const dir = projectWithPrettier();
    const prettier = mod.FORMATTERS.find((f) => f.name === 'prettier')!;
    expect(mod.buildCommand(prettier, dir, join(dir, 'a.ts'))).toEqual(['node_modules/.bin/prettier', '--write', join(dir, 'a.ts')]);
    const bare = mkdtempSync(join(tmpdir(), 'orca-fmt-bare-'));
    expect(mod.buildCommand(prettier, bare, join(bare, 'a.ts'))[0]).toBe('prettier');
  });
});

describe('formatters plugin — enabledWhen against PATH binaries (temp PATH)', () => {
  let mod: FormattersModule;
  let binDir: string;
  const oldPath = process.env.PATH;
  beforeAll(async () => {
    mod = await import(join(pluginsDir, 'formatters/index.mjs')) as FormattersModule;
    binDir = mkdtempSync(join(tmpdir(), 'orca-fmt-bin-'));
    fakeBin(join(binDir, 'ruff'));
    fakeBin(join(binDir, 'gofmt'));
    process.env.PATH = binDir;
  });
  afterAll(() => { process.env.PATH = oldPath; });

  it('ruff needs BOTH the binary on PATH and a project ruff config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-py-'));
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)).toBeNull(); // binary alone is not enough
    writeFileSync(join(dir, 'ruff.toml'), '');
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)?.name).toBe('ruff');
  });

  it('ruff also accepts a pyproject.toml that mentions ruff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-py2-'));
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.poetry]\n');
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)).toBeNull();
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)?.name).toBe('ruff');
  });

  it('gofmt needs go.mod, not just the binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-go-'));
    expect(mod.resolveFormatter(join(dir, 'main.go'), dir)).toBeNull();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    expect(mod.resolveFormatter(join(dir, 'main.go'), dir)?.name).toBe('gofmt');
  });

  it('gofmt stays off when the binary is missing from PATH, even with go.mod', () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'orca-fmt-nobin-'));
    try {
      const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-go2-'));
      writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
      expect(mod.resolveFormatter(join(dir, 'main.go'), dir)).toBeNull();
    } finally { process.env.PATH = binDir; }
  });
});

describe('formatters plugin — tools.call.after hook flow', () => {
  const loadHook = async (config?: Record<string, unknown>) => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['formatters'], logger: log, config: config ? { formatters: config } : undefined });
    const hook = reg.hooks.find((h) => h.name === 'tools.call.after') as PluginHook | undefined;
    expect(hook).toBeDefined();
    return { hook: hook!, lines };
  };
  const fire = (hook: PluginHook, workDir: string, payload: unknown) =>
    runWithPolicy(ADMIN, () => Promise.resolve(hook.run(payload)), { workDir });

  it('registers exactly one tools.call.after hook and no tools', async () => {
    const log = { info() {}, warn() {}, error() {} };
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['formatters'], logger: log });
    expect(reg.hooks.map((h) => h.name)).toEqual(['tools.call.after']);
    expect(reg.tools).toHaveLength(0);
  });

  it('formats a written file with the project formatter and logs it', async () => {
    const { hook, lines } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'src', 'a.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'const x=1');
    await fire(hook, dir, writeResult(file));
    expect(existsSync(`${file}.formatted`)).toBe(true);
    expect(lines.some((l) => l.includes(`formatted ${file} with prettier`))).toBe(true);
  });

  it('rejects a path outside the current work dir (resolve + prefix check)', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const outside = mkdtempSync(join(tmpdir(), 'orca-fmt-out-'));
    const file = join(outside, 'a.ts');
    writeFileSync(file, 'const x=1');
    await fire(hook, dir, writeResult(file));
    expect(existsSync(`${file}.formatted`)).toBe(false);
    // `..` traversal that resolves outside is refused too
    const sneaky = join(dir, '..', 'a.ts');
    await fire(hook, dir, writeResult(sneaky));
    expect(existsSync(`${resolve(sneaky)}.formatted`)).toBe(false);
  });

  it('skips files larger than 1MB', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'big.ts');
    writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 0x61));
    await fire(hook, dir, writeResult(file));
    expect(existsSync(`${file}.formatted`)).toBe(false);
  });

  it('ignores non-write tools and failed write results', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    await fire(hook, dir, { tool: 'read_file', params: { path: file }, result: { content: [], details: { ok: true, path: file } } });
    await fire(hook, dir, { tool: 'write_file', params: { path: file }, result: { content: [], details: { ok: false, path: file } } });
    await fire(hook, dir, { tool: 'write_file', params: {}, result: { content: [], details: { ok: true } } }); // no path
    await fire(hook, dir, undefined); // malformed payload
    expect(existsSync(`${file}.formatted`)).toBe(false);
  });

  it('honors the master toggle (enabled: false)', async () => {
    const { hook } = await loadHook({ enabled: false });
    const dir = projectWithPrettier();
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    await fire(hook, dir, writeResult(file));
    expect(existsSync(`${file}.formatted`)).toBe(false);
  });

  it('honors the per-formatter disabled list', async () => {
    const { hook } = await loadHook({ disabled: ['prettier'] });
    const dir = projectWithPrettier();
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    await fire(hook, dir, writeResult(file));
    expect(existsSync(`${file}.formatted`)).toBe(false);
  });

  it('logs a warning (fail-soft) when the formatter binary exits non-zero', async () => {
    const { hook, lines } = await loadHook();
    const dir = mkdtempSync(join(tmpdir(), 'orca-fmt-fail-'));
    fakeBin(join(dir, 'node_modules/.bin/prettier'), '#!/bin/sh\nexit 3\n');
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    await expect(fire(hook, dir, writeResult(file))).resolves.not.toThrow();
    expect(lines.some((l) => l.includes('formatter prettier failed'))).toBe(true);
  });

  it('does nothing without a turn work dir', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    await runWithPolicy(ADMIN, () => Promise.resolve(hook.run(writeResult(file)))); // no workDir bound
    expect(existsSync(`${file}.formatted`)).toBe(false);
  });
});
