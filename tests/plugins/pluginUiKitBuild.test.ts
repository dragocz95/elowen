import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPluginUiBundle } from '@elowen/plugin-ui-kit/build';

/** The plugin-web toolchain's load-bearing invariant: a bundle must NEVER carry its own React — all
 *  react/react-dom/jsx-runtime imports have to collapse into reads of window.ElowenUiRuntime, and the
 *  output must be a single self-contained ESM file (the daemon content-hashes it as-is). */
describe('@elowen/plugin-ui-kit build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-kit-build-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('bundles TSX to one ESM file with react aliased to the host runtime shims', async () => {
    mkdirSync(join(dir, 'web-src'));
    writeFileSync(join(dir, 'web-src', 'index.tsx'), [
      "import { useState } from 'react';",
      "import { createPortal } from 'react-dom';",
      'function Panel({ plugin }: { plugin: string }) {',
      '  const [n] = useState(0);',
      '  void createPortal;',
      '  return <div data-plugin={plugin}>{n}</div>;',
      '}',
      "window.__elowenRegisterPluginUi!('t', { requiresApiVersion: 1, pages: { '': Panel } });",
    ].join('\n'));

    const outfile = join(dir, 'web', 'index.js');
    await buildPluginUiBundle({ entry: join(dir, 'web-src', 'index.tsx'), outfile });

    const out = readFileSync(outfile, 'utf8');
    // The shims' runtime reads are present; the real React implementation is not.
    expect(out).toContain('window.ElowenUiRuntime');
    expect(out).toContain('runtime.react');
    expect(out).toContain('runtime.reactDom');
    expect(out).toContain('runtime.jsxRuntime');
    expect(out).not.toMatch(/react\.development|__SECRET_INTERNALS|react\.production/);
    // Self-contained ESM: no leftover imports to resolve at load time.
    expect(out).not.toMatch(/^\s*import\s.*from\s+["'](react|react-dom)/m);
  });
});
