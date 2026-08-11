import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SKINS, activeSkin } from '../../lib/skins';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('activeSkin', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves a known skin, tolerating case and whitespace from a unit file', () => {
    vi.stubEnv('ELOWEN_SKIN', ' Midnight ');
    expect(activeSkin()).toBe('midnight');
  });

  it('returns null for unset, unknown and malformed values — the built-in design must render', () => {
    vi.stubEnv('ELOWEN_SKIN', '');
    expect(activeSkin()).toBeNull();
    vi.stubEnv('ELOWEN_SKIN', 'ghost');
    expect(activeSkin()).toBeNull();
    vi.stubEnv('ELOWEN_SKIN', '../etc');
    expect(activeSkin()).toBeNull();
  });
});

// The registry lives in three places that cannot reference each other (a TS list, CSS @imports, and
// folders on disk) — this contract holds them together so adding a skin cannot half-land.
describe('skin registry contract', () => {
  it('every skin has a folder with skin.css and an @import line in skins/index.css', () => {
    const index = readFileSync(join(root, 'skins', 'index.css'), 'utf-8');
    for (const skin of SKINS) {
      expect(index, `missing @import for skin "${skin}"`).toContain(`@import "./${skin}/skin.css";`);
      expect(readFileSync(join(root, 'skins', skin, 'skin.css'), 'utf-8').length).toBeGreaterThan(0);
    }
    // No orphan import either — an @import without a registry entry ships unreachable CSS.
    const imports = [...index.matchAll(/@import "\.\/([^/]+)\/skin\.css";/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual([...SKINS].sort());
  });

  it('every rule in every skin is scoped under its own data-skin attribute', () => {
    for (const skin of SKINS) {
      const css = readFileSync(join(root, 'skins', skin, 'skin.css'), 'utf-8');
      // Strip comments, then require each selector head to carry the scope. An unscoped rule would
      // leak into every instance built from this repo, whatever design they actually run.
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const selectors = [...bare.matchAll(/(^|\})\s*([^@{}]+)\{/g)].map((m) => m[2]!.trim());
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) {
        for (const part of selector.split(',')) {
          expect(part.trim(), `unscoped selector in ${skin}/skin.css: "${part.trim()}"`)
            .toContain(`[data-skin='${skin}']`);
        }
      }
    }
  });

  it('globals.css imports the skin registry and the layout wires the attribute', () => {
    expect(readFileSync(join(root, 'app', 'globals.css'), 'utf-8')).toContain('@import "../skins/index.css";');
    expect(readFileSync(join(root, 'app', 'layout.tsx'), 'utf-8')).toContain("'data-skin': skin");
  });
});
