import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface DistIntegrity {
  cleanDist(root: string): void;
  inspectDistParity(root: string): { missing: string[]; orphaned: string[] };
  assertDistParity(root: string): void;
}

const roots: string[] = [];
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const write = (root: string, relative: string, body = ''): void => {
  const file = join(root, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, body);
};

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'elowen-dist-integrity-'));
  roots.push(root);
  write(root, 'package.json', '{"name":"elowen"}');
  return root;
};

const integrity = async (): Promise<DistIntegrity> => {
  const module = await import('../../scripts/dist-integrity.mjs').catch(() => null);
  expect(module).not.toBeNull();
  return module as unknown as DistIntegrity;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dist integrity', () => {
  it('accepts TypeScript output and copied JavaScript assets', async () => {
    const root = fixture();
    write(root, 'src/cli/main.ts', 'export {};');
    write(root, 'src/cli/esm.mts', 'export {};');
    write(root, 'src/cli/common.cts', 'export {};');
    write(root, 'src/cli/types.d.ts', 'export type Value = string;');
    write(root, 'src/plugins/registry.ts', 'export {};');
    write(root, 'plugins/demo/index.mjs', 'export {};');
    write(root, 'prompts/check.mjs', 'export {};');
    write(root, 'dist/cli/main.js', 'export {};');
    write(root, 'dist/cli/esm.mjs', 'export {};');
    write(root, 'dist/cli/common.cjs', 'export {};');
    write(root, 'dist/plugins/registry.js', 'export {};');
    write(root, 'dist/plugins/demo/index.mjs', 'export {};');
    write(root, 'dist/prompts/check.mjs', 'export {};');

    expect((await integrity()).inspectDistParity(root)).toEqual({ missing: [], orphaned: [] });
  });

  it('reports missing and orphaned JavaScript output with stable paths', async () => {
    const root = fixture();
    write(root, 'src/cli/main.ts', 'export {};');
    write(root, 'dist/legacy.js', 'export {};');

    const api = await integrity();
    expect(api.inspectDistParity(root)).toEqual({
      missing: ['dist/cli/main.js'],
      orphaned: ['dist/legacy.js'],
    });
    expect(() => api.assertDistParity(root)).toThrow(
      'missing output: dist/cli/main.js\norphaned output: dist/legacy.js',
    );
  });

  it('cleans only the validated repository dist directory', async () => {
    const root = fixture();
    write(root, 'dist/legacy.js', 'export {};');
    write(root, 'outside.txt', 'keep');

    (await integrity()).cleanDist(root);

    expect(existsSync(join(root, 'dist/legacy.js'))).toBe(false);
    expect(existsSync(join(root, 'outside.txt'))).toBe(true);
  });

  it('refuses to clean a non-Elowen directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'not-elowen-'));
    roots.push(root);
    write(root, 'package.json', '{"name":"other"}');
    write(root, 'dist/legacy.js', 'export {};');

    const api = await integrity();
    expect(() => api.cleanDist(root)).toThrow('expected package name "elowen"');
    expect(existsSync(join(root, 'dist/legacy.js'))).toBe(true);
  });

  it('removes a stale emitted module during the normal build', () => {
    const stale = join(repositoryRoot, 'dist/cli/chat/legacy-build-output.js');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, 'export {};');

    try {
      const result = spawnSync('npm', ['run', 'build', '--silent'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(stale)).toBe(false);
    } finally {
      rmSync(stale, { force: true });
    }
  });
});
