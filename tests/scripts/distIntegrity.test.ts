import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface DistIntegrity {
  cleanDist(root: string): void;
  inspectDistParity(root: string): { missing: string[]; orphaned: string[] };
  inspectPluginFolders(root: string): { unmanifested: string[] };
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

  // Regression: `git rm plugins/<name>` leaves the plugin's GITIGNORED build output (web/index.js)
  // behind, the build copies that folder into dist/, and it ships inside the npm package. The loader
  // then finds a folder for an enabled name, cannot read its manifest, and logs a bare ERROR next to a
  // plugin that loaded fine from the user directory. Parity cannot see it — source and dist agree.
  it('rejects a plugin folder left behind without its manifest', async () => {
    const root = fixture();
    write(root, 'plugins/keeper/elowen-plugin.json', '{"name":"keeper"}');
    write(root, 'plugins/keeper/index.mjs', 'export {};');
    write(root, 'dist/plugins/keeper/index.mjs', 'export {};');
    write(root, 'plugins/ghost/web/index.js', 'export {};');
    write(root, 'dist/plugins/ghost/web/index.js', 'export {};');

    const api = await integrity();
    expect(api.inspectDistParity(root)).toEqual({ missing: [], orphaned: [] });
    expect(api.inspectPluginFolders(root)).toEqual({ unmanifested: ['ghost'] });
    expect(() => api.assertDistParity(root)).toThrow(
      'plugin folder without elowen-plugin.json (leftover of a deleted plugin?): plugins/ghost',
    );
  });

  it('accepts the shared underscore folders that are not plugins', async () => {
    const root = fixture();
    write(root, 'plugins/_shared/httpClient.mjs', 'export {};');
    write(root, 'dist/plugins/_shared/httpClient.mjs', 'export {};');

    expect((await integrity()).inspectPluginFolders(root)).toEqual({ unmanifested: [] });
  });

  it('passes against the real repository', async () => {
    expect((await integrity()).inspectPluginFolders(repositoryRoot)).toEqual({ unmanifested: [] });
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

  // This one drives the REAL `npm run build` against THIS checkout, which is the only way to prove the
  // shipped pipeline cleans up after itself — and also means it rewrites `dist/` in place. When the
  // checkout is a live installation (the daemon loads its modules from that very directory, and a
  // scheduled turn has already died on ENOENT mid-rebuild), running it as part of an ordinary
  // `vitest run` quietly redeploys the machine. So it runs where a build is expected — CI — and says
  // why it stood aside anywhere else, instead of skipping silently.
  const liveBuildAllowed = process.env.ELOWEN_DIST_BUILD_TEST === '1';
  it.skipIf(!liveBuildAllowed)('removes a stale emitted module during the normal build', { timeout: 180_000 }, () => {
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
      const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
        bin: { elowen: string };
      };
      expect(statSync(join(repositoryRoot, manifest.bin.elowen)).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(stale, { force: true });
    }
  });
});
