import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pluginBundleFiles } from './pluginBundleFiles.js';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string>): void {
  root = mkdtempSync(join(tmpdir(), 'plugin-bundle-files-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, 'fixture', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
}
const manifest = JSON.stringify({ web: { entry: 'web/index.js' } });

describe('plugin bundle contract inputs', () => {
  it('scans the shipped entry when the registry owns the sources', () => {
    fixture({ 'elowen-plugin.json': manifest, 'web/index.js': 'const s = hooks.usePluginStrings("fixture");' });
    expect(pluginBundleFiles(root, 'fixture')).toEqual([join(root, 'fixture/web/index.js')]);
  });

  it('scans local sources without double-counting generated output or tests', () => {
    fixture({ 'elowen-plugin.json': manifest, 'web/index.js': '', 'web-src/Panel.tsx': '', 'web-src/Panel.test.tsx': '' });
    expect(pluginBundleFiles(root, 'fixture')).toEqual([join(root, 'fixture/web-src/Panel.tsx')]);
  });

  it('fails when the manifest declares an absent shipped entry', () => {
    fixture({ 'elowen-plugin.json': manifest });
    expect(() => pluginBundleFiles(root, 'fixture')).toThrow();
  });
});
