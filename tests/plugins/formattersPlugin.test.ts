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
  const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-'));
  fakeBin(join(dir, 'node_modules/.bin/prettier'), '#!/bin/sh\necho formatted > "$2.formatted"\n');
  return dir;
};

const writeResult = (path: string) => ({ tool: 'Write', params: { path }, result: { content: [], details: { ok: true, path } } });

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
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-empty-'));
    expect(mod.resolveFormatter(join(dir, 'a.ts'), dir)).toBeNull();
    expect(mod.resolveFormatter(join(dir, 'a.go'), dir)).toBeNull();
  });

  it('pint is gated on vendor/bin/pint being present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-php-'));
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
    const bare = mkdtempSync(join(tmpdir(), 'elowen-fmt-bare-'));
    expect(mod.buildCommand(prettier, bare, join(bare, 'a.ts'))[0]).toBe('prettier');
  });
});

describe('formatters plugin — enabledWhen against PATH binaries (temp PATH)', () => {
  let mod: FormattersModule;
  let binDir: string;
  const oldPath = process.env.PATH;
  beforeAll(async () => {
    mod = await import(join(pluginsDir, 'formatters/index.mjs')) as FormattersModule;
    binDir = mkdtempSync(join(tmpdir(), 'elowen-fmt-bin-'));
    fakeBin(join(binDir, 'ruff'));
    fakeBin(join(binDir, 'gofmt'));
    process.env.PATH = binDir;
  });
  afterAll(() => { process.env.PATH = oldPath; });

  it('ruff needs BOTH the binary on PATH and a project ruff config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-py-'));
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)).toBeNull(); // binary alone is not enough
    writeFileSync(join(dir, 'ruff.toml'), '');
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)?.name).toBe('ruff');
  });

  it('ruff also accepts a pyproject.toml that mentions ruff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-py2-'));
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.poetry]\n');
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)).toBeNull();
    writeFileSync(join(dir, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n');
    expect(mod.resolveFormatter(join(dir, 'a.py'), dir)?.name).toBe('ruff');
  });

  it('gofmt needs go.mod, not just the binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-go-'));
    expect(mod.resolveFormatter(join(dir, 'main.go'), dir)).toBeNull();
    writeFileSync(join(dir, 'go.mod'), 'module example.com/x\n');
    expect(mod.resolveFormatter(join(dir, 'main.go'), dir)?.name).toBe('gofmt');
  });

  it('gofmt stays off when the binary is missing from PATH, even with go.mod', () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'elowen-fmt-nobin-'));
    try {
      const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-go2-'));
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

  it('formats a written file with the project formatter, logs it and annotates the result (details.notes)', async () => {
    const { hook, lines } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'src', 'a.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'const x=1');
    const payload = writeResult(file);
    await fire(hook, dir, payload);
    expect(existsSync(`${file}.formatted`)).toBe(true);
    expect(lines.some((l) => l.includes(`formatted ${file} with prettier`))).toBe(true);
    // The awaited tools.call.after contract: a successful format appends a transcript note in place.
    expect((payload.result.details as { notes?: string[] }).notes).toEqual(['formatted a.ts with prettier']);
  });

  it('invalidates the files-plugin details.diff after a successful format (never a diff that contradicts disk)', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    const payload = writeResult(file);
    // The files plugin computed this diff at write time; the reformat below rewrites the file on disk.
    (payload.result.details as { diff?: string }).diff = '-    1 const x=1\n+    1 const x = 1;';
    await fire(hook, dir, payload);
    // The stale pre-format diff is dropped; only the note survives (messageView falls back to notes-only).
    expect((payload.result.details as { diff?: string }).diff).toBeUndefined();
    expect((payload.result.details as { notes?: string[] }).notes).toEqual(['formatted a.ts with prettier']);
  });

  it('keeps details.diff when the formatter fails — the file on disk is unchanged, so the diff still matches', async () => {
    const { hook } = await loadHook();
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-difffail-'));
    fakeBin(join(dir, 'node_modules/.bin/prettier'), '#!/bin/sh\nexit 3\n');
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    const payload = writeResult(file);
    (payload.result.details as { diff?: string }).diff = 'DIFF';
    await fire(hook, dir, payload);
    expect((payload.result.details as { diff?: string }).diff).toBe('DIFF');
    expect((payload.result.details as { notes?: string[] }).notes).toBeUndefined();
  });

  it('appends its note to an EXISTING details.notes array instead of clobbering it', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    const payload = writeResult(file);
    (payload.result.details as { notes?: string[] }).notes = ['earlier note'];
    await fire(hook, dir, payload);
    expect((payload.result.details as { notes?: string[] }).notes).toEqual(['earlier note', 'formatted a.ts with prettier']);
  });

  it('rejects a path outside the current work dir (resolve + prefix check)', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const outside = mkdtempSync(join(tmpdir(), 'elowen-fmt-out-'));
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
    await fire(hook, dir, { tool: 'Read', params: { path: file }, result: { content: [], details: { ok: true, path: file } } });
    await fire(hook, dir, { tool: 'Write', params: { path: file }, result: { content: [], details: { ok: false, path: file } } });
    await fire(hook, dir, { tool: 'Write', params: {}, result: { content: [], details: { ok: true } } }); // no path
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

  it('logs a warning (fail-soft) when the formatter binary exits non-zero — and appends NO note', async () => {
    const { hook, lines } = await loadHook();
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-fail-'));
    fakeBin(join(dir, 'node_modules/.bin/prettier'), '#!/bin/sh\nexit 3\n');
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    const payload = writeResult(file);
    await expect(fire(hook, dir, payload)).resolves.not.toThrow();
    expect(lines.some((l) => l.includes('formatter prettier failed'))).toBe(true);
    expect((payload.result.details as { notes?: string[] }).notes).toBeUndefined();
  });

  it('does nothing without a turn work dir', async () => {
    const { hook } = await loadHook();
    const dir = projectWithPrettier();
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    await runWithPolicy(ADMIN, () => Promise.resolve(hook.run(writeResult(file)))); // no workDir bound
    expect(existsSync(`${file}.formatted`)).toBe(false);
  });

  it('applies a configured maxFileBytes override (skips a file the 1MB default would still format)', async () => {
    const { hook } = await loadHook({ maxFileBytes: 262144 }); // schema min
    const dir = projectWithPrettier();
    const file = join(dir, 'mid.ts');
    writeFileSync(file, Buffer.alloc(300_000, 0x61)); // under the 1MB default, over the configured cap
    await fire(hook, dir, writeResult(file));
    expect(existsSync(`${file}.formatted`)).toBe(false);
  });

  it('applies a configured timeoutMs override (kills a subprocess the 10s default would let finish)', async () => {
    const { hook, lines } = await loadHook({ timeoutMs: 5000 }); // schema min
    const dir = mkdtempSync(join(tmpdir(), 'elowen-fmt-timeout-'));
    fakeBin(join(dir, 'node_modules/.bin/prettier'), '#!/bin/sh\nsleep 6\n');
    const file = join(dir, 'a.ts');
    writeFileSync(file, 'const x=1');
    await fire(hook, dir, writeResult(file));
    expect(lines.some((l) => l.includes('formatter prettier failed'))).toBe(true);
  }, 10000);
});

describe('formatters plugin — configNumber (config override clamping)', () => {
  it('falls back to the default when unset/invalid, passes through in-range overrides, and clamps out-of-range ones', async () => {
    const mod = await import(join(pluginsDir, 'formatters/index.mjs')) as { configNumber: (v: unknown, def: number, min: number, max: number) => number };
    expect(mod.configNumber(undefined, 10_000, 5000, 60_000)).toBe(10_000); // unset -> RUN_TIMEOUT_MS default
    expect(mod.configNumber(20_000, 10_000, 5000, 60_000)).toBe(20_000); // in-range override
    expect(mod.configNumber(1, 10_000, 5000, 60_000)).toBe(5000); // clamped to min
    expect(mod.configNumber(999_999, 10_000, 5000, 60_000)).toBe(60_000); // clamped to max
    expect(mod.configNumber(undefined, 1_048_576, 262_144, 10_485_760)).toBe(1_048_576); // unset -> MAX_FILE_BYTES default
  });
});
