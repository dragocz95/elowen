import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugins } from '../../src/plugins/loader.js';
import type { PluginLogger } from '../../src/plugins/api.js';

const silentLogger: PluginLogger = { info() {}, warn() {}, error() {} };

function writePlugin(root: string, name: string, version: string, marker: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify({
    name, version, apiVersion: '1', description: 'x', entry: 'index.mjs',
  }));
  // Top-level side effect fires on every FRESH module evaluation; a cached import would not re-run it.
  writeFileSync(join(dir, 'index.mjs'), `globalThis.${marker} = (globalThis.${marker} ?? 0) + 1;\nexport function register(){}`);
}

describe('loadPlugins import cache-busting', () => {
  it('re-imports a plugin whose bytes+version changed under the same path', async () => {
    const marker = `__mkbust_${Date.now()}`;
    const root = mkdtempSync(join(tmpdir(), 'orca-bust-'));
    writePlugin(root, 'demo', '1.0.0', marker);
    await loadPlugins({ dirs: [root], enabled: ['demo'], logger: silentLogger });
    expect((globalThis as Record<string, unknown>)[marker]).toBe(1);

    // Simulate a marketplace update: same folder/path, new bytes + a bumped version + newer mtime.
    writePlugin(root, 'demo', '2.0.0', marker);
    const now = Date.now() / 1000 + 5;
    utimesSync(join(root, 'demo', 'index.mjs'), now, now);
    await loadPlugins({ dirs: [root], enabled: ['demo'], logger: silentLogger });
    // Without the ?v=version-mtime cache-bust this stays 1 (Node returns the cached module).
    expect((globalThis as Record<string, unknown>)[marker]).toBe(2);
  });

  it('rejects a manifest entry that escapes the plugin dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-escape-'));
    const dir = join(root, 'evil');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'orca-plugin.json'), JSON.stringify({
      name: 'evil', version: '1.0.0', apiVersion: '1', description: 'x', entry: '../../escape.mjs',
    }));
    const error = vi.fn();
    const registry = await loadPlugins({ dirs: [root], enabled: ['evil'], logger: { ...silentLogger, error } });
    expect(registry.tools).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('escapes plugin dir'));
  });
});
