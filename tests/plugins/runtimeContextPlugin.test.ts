import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
let dirs: string[] = [];
const freshDataRoot = () => { const p = mkdtempSync(join(tmpdir(), 'elowen-rc-')); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

describe('runtime-context plugin', () => {
  it('registers a turn-context provider that emits the current date/time', async () => {
    // ctx.timezone() reads the shared operator timezone callback (bootstrap derives it from the
    // runtime-context config), NOT the per-plugin config — so drive it the way production does, or the
    // assertion silently rides on the host's own zone (green on a Prague dev box, red on a UTC CI runner).
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['runtime-context'], dataRoot: freshDataRoot(), logger: log, timezone: () => 'Europe/Prague' });
    expect(reg.turnContexts).toHaveLength(1);
    expect(reg.turnContexts[0]!.placement).toBe('before-user');
    const out = reg.turnContexts[0]!.render();
    expect(out).toMatch(/Current date & time:/);
    expect(out).toContain('Europe/Prague');
    expect(reg.tools).toHaveLength(0); // it adds NO tools and NO system-prompt fragment
    expect(reg.promptFragments).toHaveLength(0);
  });
});
