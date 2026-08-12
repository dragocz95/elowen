import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectPluginClassSources } from '../../scripts/collect-plugin-classes.mjs';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

/** Plugin bundles style themselves with the host's utilities, but Tailwind only scans sources inside the
 *  web project root — a utility used solely by a plugin is generated ONLY because globals.css scans the
 *  generated mirror of the plugin sources. Lose either half and plugin pages quietly render unstyled, in
 *  a way no unit test of a component would notice. */
describe('plugin class sources', () => {
  it('globals.css scans the generated plugin source mirror', () => {
    const css = readFileSync(join(repoRoot, 'web', 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/@source\s+"\.\/styles\/plugin-classes\.txt"/);
  });

  it('the mirror carries the markup of every plugin that ships a browser bundle', () => {
    const blob = collectPluginClassSources(repoRoot);
    // A container-query variant no core page uses: it exists in the built CSS only via this mirror.
    expect(blob).toContain('@sm:');
    for (const plugin of ['agents', 'cronjob', 'editor', 'skills', 'subagent']) {
      expect(blob).toContain(`plugins/${plugin}/web-src`);
    }
  });

  it('regenerates the web build chain: build and dev both refresh the mirror before Next runs', () => {
    // A stale mirror is invisible — the page just misses a class — so the refresh must be wired into the
    // scripts themselves rather than left to whoever remembers to run it.
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'web', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toContain('collect-plugin-classes.mjs');
    expect(pkg.scripts.dev).toContain('collect-plugin-classes.mjs');
  });
});
