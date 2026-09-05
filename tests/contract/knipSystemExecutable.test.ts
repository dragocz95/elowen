import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const config = JSON.parse(readFileSync(join(root, 'knip.json'), 'utf8')) as {
  workspaces: Record<string, { ignoreUnresolved?: string[] }>;
};
let fixture: string | undefined;
afterEach(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

// Knip treats an absolute execFileSync target as a file import before its binary scanner runs.
// Certbot is provisioned by the host, not npm. Its absence must not hide missing JavaScript modules.
describe('Knip system executable exception', () => {
  it('names only the exact Certbot executable in the root workspace', () => {
    expect(config.workspaces['.']?.ignoreUnresolved).toEqual(['/usr/bin/certbot']);
  });

  it('still reports missing JavaScript imports, including a similar absolute path', () => {
    fixture = mkdtempSync(join(tmpdir(), 'elowen-knip-executable-'));
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'knip-executable-fixture', version: '1.0.0', type: 'module' }));
    writeFileSync(join(fixture, 'knip.json'), JSON.stringify({
      entry: ['entry.mjs'], project: ['*.mjs'],
      ignoreUnresolved: config.workspaces['.']?.ignoreUnresolved ?? [],
    }));
    writeFileSync(join(fixture, 'entry.mjs'), [
      "import { execFileSync } from 'node:child_process';",
      "import './missing-module.mjs';",
      "import '/usr/bin/certbot-gate-fixture.mjs';",
      "execFileSync('/usr/bin/certbot', []);",
    ].join('\n'));
    const result = spawnSync(process.execPath, [
      resolve(root, 'node_modules/knip/bin/knip.js'), '--directory', fixture,
      '--include', 'unresolved', '--reporter', 'json', '--no-progress', '--no-config-hints',
    ], { encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout) as { issues: { unresolved: { name: string }[] }[] };
    expect(report.issues.flatMap((issue) => issue.unresolved.map((entry) => entry.name)).sort()).toEqual([
      './missing-module.mjs', '/usr/bin/certbot-gate-fixture.mjs',
    ]);
  }, 30_000);
});
