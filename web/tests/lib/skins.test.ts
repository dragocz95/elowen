import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BUILTIN_SKIN,
  SKINS,
  SKIN_CHOICES,
  allowedSkinChoices,
  currentSkinChoice,
  nextSkinChoice,
  resolveSkin,
} from '../../lib/skins';
import { activeSkin } from '../../lib/skinEnv';

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

  /** Split a selector list on its TOP-LEVEL commas only.
   *
   *  A plain `split(',')` cuts inside `:is()`, `:where()` and `:not()` too, and each fragment it produces
   *  then looks like a bare unscoped selector. A correctly scoped rule such as
   *  `:root[data-skin='x'] :is(.a, .b) .c` was therefore reported as an unscoped `.b` — a false alarm
   *  that says the skin leaks into every instance, which is the one thing this check exists to catch. */
  const splitSelectorList = (selector: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of selector) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
      current += ch;
    }
    parts.push(current);
    return parts;
  };

  it('every rule in every skin is scoped under its own data-skin attribute', () => {
    for (const skin of SKINS) {
      const css = readFileSync(join(root, 'skins', skin, 'skin.css'), 'utf-8');
      // Strip comments, then require each selector head to carry the scope. An unscoped rule would
      // leak into every instance built from this repo, whatever design they actually run.
      const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const selectors = [...bare.matchAll(/(^|\})\s*([^@{}]+)\{/g)].map((m) => m[2]!.trim());
      expect(selectors.length).toBeGreaterThan(0);
      for (const selector of selectors) {
        for (const part of splitSelectorList(selector)) {
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

  it('reserves the built-in name, which no compiled skin may take', () => {
    // A stored choice is one string. If a skin were ever named `default`, "the plain design" and "that
    // skin" would be the same value and nothing downstream could tell them apart.
    expect(SKINS as readonly string[]).not.toContain(BUILTIN_SKIN);
    expect(SKIN_CHOICES).toEqual([BUILTIN_SKIN, ...SKINS]);
  });
});

describe('skin choice resolution', () => {
  const allowed = allowedSkinChoices([BUILTIN_SKIN, 'midnight']);

  it('offers only names this build compiled, in the order the operator listed them', () => {
    expect(allowedSkinChoices(['midnight', BUILTIN_SKIN])).toEqual(['midnight', BUILTIN_SKIN]);
    // A name left behind by a deployment that used to ship a skin would otherwise be offered as an
    // option that visibly does nothing.
    expect(allowedSkinChoices(['chetty', 'midnight'])).toEqual(['midnight']);
    expect(allowedSkinChoices(['midnight', 'midnight'])).toEqual(['midnight']);
    expect(allowedSkinChoices(null)).toEqual([]);
  });

  it('honours an allowed choice, and maps the built-in one to no attribute at all', () => {
    expect(resolveSkin('midnight', allowed, null)).toBe('midnight');
    expect(resolveSkin(BUILTIN_SKIN, allowed, 'midnight')).toBeNull();
  });

  it('drops a choice the admin has revoked, back to the deployment default', () => {
    // This is what makes the allow-list a control rather than a suggestion: nobody has to reach into a
    // stored value for a revocation to take effect on the next document.
    expect(resolveSkin('midnight', allowedSkinChoices([BUILTIN_SKIN]), 'midnight')).toBe('midnight');
    expect(resolveSkin('midnight', [], null)).toBeNull();
    expect(resolveSkin('ghost', allowed, 'midnight')).toBe('midnight');
    expect(resolveSkin(null, allowed, 'midnight')).toBe('midnight');
  });

  it('starts the cycle from what is actually on screen', () => {
    expect(currentSkinChoice('midnight', allowed, null)).toBe('midnight');
    // Nothing chosen: the visible design is the operator's default, and that is where cycling starts.
    expect(currentSkinChoice(null, allowed, 'midnight')).toBe('midnight');
    expect(currentSkinChoice(null, allowed, null)).toBe(BUILTIN_SKIN);
    // The deployment default is not itself on offer — cycling must not claim it was picked.
    expect(currentSkinChoice(null, allowedSkinChoices([BUILTIN_SKIN]), 'midnight')).toBeNull();
  });

  it('cycles forward and wraps, and starts at the first entry from nothing', () => {
    expect(nextSkinChoice(BUILTIN_SKIN, allowed)).toBe('midnight');
    expect(nextSkinChoice('midnight', allowed)).toBe(BUILTIN_SKIN);
    expect(nextSkinChoice(null, allowed)).toBe(BUILTIN_SKIN);
    expect(nextSkinChoice(null, [])).toBeNull();
  });
});
