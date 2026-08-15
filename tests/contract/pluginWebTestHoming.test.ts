import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A bundled plugin's browser bundle must not carry test files, because nothing would run them.
 *
 *  web/vitest.config.ts used to collect them through `../plugins/*_/web-src/**_/*.test.{ts,tsx}`. Every
 *  plugin that shipped such tests has since moved to the plugin registry, which runs them itself, so that
 *  glob was removed — it had stopped matching anything, and a glob that matches nothing is exactly how a
 *  suite goes quiet: the run stays green while 26 files' worth of assertions simply stop existing.
 *
 *  Removing it leaves a trap for whoever adds the next bundled plugin: they would write a test next to
 *  their component, see it collected by no runner, and never learn. This fails the moment that happens,
 *  with the two honest ways out — run it from the registry, or teach web/vitest.config.ts to collect it
 *  again. */
describe('a bundled plugin does not hide tests nothing runs', () => {
  const pluginWebTests = globSync('plugins/*/web-src/**/*.test.{ts,tsx}', { cwd: repoRoot });

  it('no bundled plugin ships a browser-bundle test file', () => {
    expect(pluginWebTests).toEqual([]);
  });

  it('the web suite no longer claims to collect them', () => {
    const config = readFileSync(resolve(repoRoot, 'web/vitest.config.ts'), 'utf-8');
    // Read the `include` list itself rather than the whole file, which discusses the removed glob in prose.
    const include = /^\s*include:\s*\[(.*)\]/m.exec(config)?.[1];
    expect(include, 'web/vitest.config.ts has no include list').toBeTruthy();
    // Guards the guard from the other side: if someone restores the glob, the test above stops being the
    // rule that governs — plugin tests WOULD run again, and this file should be deleted rather than left
    // asserting a constraint that no longer applies.
    expect(include).not.toContain('web-src');
  });

  it('still finds the bundled plugins it is scanning', () => {
    // An empty result above proves nothing if the scan itself is broken (wrong root, renamed directory).
    // At least one bundled plugin with a browser bundle must exist for the check to mean anything.
    const bundles = globSync('plugins/*/web-src/index.tsx', { cwd: repoRoot });
    expect(bundles.length, `scanned ${relative(process.cwd(), repoRoot)}`).toBeGreaterThan(0);
  });
});
