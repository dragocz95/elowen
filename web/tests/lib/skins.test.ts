import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BUILTIN_SKIN,
  DEFAULT_SKIN,
  SKINS,
  SKIN_DEFINITIONS,
  SKIN_FAMILY_SHEETS,
  allowedSkinChoices,
  currentSkinChoice,
  nextSkinChoice,
  resolveSkin,
  shellProfileFor,
  skinDisplayName,
  type SkinChoice,
  type SkinName,
} from '../../lib/skins';
import { activeSkin } from '../../lib/skinEnv';
import { dictionaries } from '../../lib/i18n/dictionaries';
import { en } from '../../lib/i18n/dictionaries/en';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/** Every selector fragment in a stylesheet, comments stripped and selector lists flattened. One parser
 *  for both guards below — the per-skin one and the shared-stylesheet one — so the false alarm above
 *  stays fixed in exactly one place.
 *
 *  Brace-counting rather than a regex, deliberately. The regex this replaced anchored each selector on
 *  the `}` that closed the previous rule, so the FIRST rule inside every `@media` / `@container` block —
 *  which is preceded by `{` — was never extracted and never checked. Nothing had slipped through it yet,
 *  but a guard whose whole purpose is stopping a skin from leaking into every other design cannot have a
 *  shape of rule it silently cannot see. */
const selectorFragments = (css: string): string[] => {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const fragments: string[] = [];
  let prelude = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    // Quoted text is copied through whole: a selector's `[data-skin='x']` must survive intact, and a
    // brace inside a string is not a block boundary.
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      const close = end === -1 ? source.length : end;
      prelude += source.slice(i, close + 1);
      i = close;
      continue;
    }
    if (ch === '{') {
      const head = prelude.trim();
      // An at-rule prelude (`@media (...)`) is a condition, not a selector; the rules inside it are
      // reached on their own next time round. A declaration block cannot contain `{`, so anything else
      // arriving here is a selector list.
      if (head && !head.startsWith('@')) fragments.push(...splitSelectorList(head).map((part) => part.trim()));
      prelude = '';
      continue;
    }
    if (ch === '}') { prelude = ''; continue; }
    prelude += ch;
  }
  return fragments;
};

describe('the scope guards can see every rule they claim to check', () => {
  // The extractor IS the guard: a rule it does not return is a rule nothing below checks, and the leak
  // it exists to catch would ship green. The first rule inside an at-rule block is the case the previous
  // regex could not reach.
  it('extracts the first rule inside an at-rule block, and every rule after it', () => {
    const css = `
      @media (pointer: coarse) {
        .leaked-first { min-height: 44px; }
        :root[data-skin='x'] .second { min-height: 44px; }
      }
      :root[data-skin='x'] .top-level { color: red; }
    `;
    expect(selectorFragments(css)).toEqual(['.leaked-first', ":root[data-skin='x'] .second", ":root[data-skin='x'] .top-level"]);
  });

  it('keeps a selector list whole through :is(), and ignores comments and declarations', () => {
    const css = `
      /* .commented-out { } */
      :root:is([data-skin='a'], [data-skin='b']) .one,
      :root[data-skin='a'] .two { content: '}'; background: url("a{b"); }
    `;
    expect(selectorFragments(css)).toEqual([":root:is([data-skin='a'], [data-skin='b']) .one", ":root[data-skin='a'] .two"]);
  });
});

describe('activeSkin', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('resolves a known skin, tolerating case and whitespace from a unit file', () => {
    vi.stubEnv('ELOWEN_SKIN', ' Studio-OLED ');
    expect(activeSkin()).toBe('studio-oled');
  });

  it('returns null for unset, unknown and malformed values so the resolver uses studio-light', () => {
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

  it('ships no stylesheet for a skin the registry does not list', () => {
    // The registry test above reads `skins/<id>/skin.css` for each SKINS entry and the @imports beside
    // them, so it walks the list — never the directory. Retiring a skin by taking it out of SKINS and
    // out of index.css therefore leaves its folder on disk with nothing complaining: unreachable CSS in
    // the tree, and a name that looks alive to the next reader deciding what the app supports.
    const families = new Set(SKIN_FAMILY_SHEETS.map(({ sharedStylesheets }) => sharedStylesheets.map((path) => path.split('/')[0]!)).flat());
    const folders = readdirSync(join(root, 'skins'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !families.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(folders, 'a skin folder that no longer belongs to any registry entry').toEqual([...SKINS].sort());
  });

  it('every rule in every skin is scoped under its own data-skin attribute', () => {
    for (const skin of SKINS) {
      // Require each selector head to carry the scope. An unscoped rule would leak into every instance
      // built from this repo, whatever design they actually run.
      const fragments = selectorFragments(readFileSync(join(root, 'skins', skin, 'skin.css'), 'utf-8'));
      expect(fragments.length).toBeGreaterThan(0);
      for (const part of fragments) {
        expect(part, `unscoped selector in ${skin}/skin.css: "${part}"`).toContain(`[data-skin='${skin}']`);
      }
    }
  });

  it('globals.css imports the skin registry and the layout wires the attribute', () => {
    expect(readFileSync(join(root, 'app', 'globals.css'), 'utf-8')).toContain('@import "../skins/index.css";');
    // Unconditionally, not behind a truthiness check: the resolution has no "no skin" value left, and a
    // conditional here is how one would creep back in.
    expect(readFileSync(join(root, 'app', 'layout.tsx'), 'utf-8')).toContain('data-skin={skin}');
  });

  it('reserves the built-in name, which no compiled skin may take', () => {
    // A stored choice is one string. If a skin were ever named `default`, "the plain design" and "that
    // skin" would be the same value and nothing downstream could tell them apart.
    expect(SKINS as readonly string[]).not.toContain(BUILTIN_SKIN);
    expect([...SKINS]).toEqual(['studio-light', 'studio-oled']);
  });

  it('carries exactly one definition per compiled skin, and none for a skin that does not exist', () => {
    // SKINS stays a tuple of ids because that is what the app consumes — a directory name, a data-skin
    // value, a member test. The metadata lives beside it, and the two drifting apart is what this pins:
    // a Record over SkinName makes the compiler reject most of it, but a duplicated id in SKINS would
    // collapse two entries into one silently.
    expect(Object.keys(SKIN_DEFINITIONS).sort()).toEqual([...SKINS].sort());
    expect(new Set(SKINS).size, 'a skin id is listed twice').toBe(SKINS.length);
    for (const [id, definition] of Object.entries(SKIN_DEFINITIONS)) expect(definition.id).toBe(id);
  });

  it('names every skin in every shipped locale, and never shows a raw id', () => {
    // The id is a directory and an attribute value: "studio-oled" is not a name to put in front of
    // anyone. A definition pointing at a key one dictionary is missing would render `undefined`.
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      for (const definition of Object.values(SKIN_DEFINITIONS)) {
        const name = dictionary.common.skinNames[definition.nameKey];
        expect(name, `${locale} does not name skin "${definition.id}"`).toBeTruthy();
        expect(name, `${locale} shows the raw id for "${definition.id}"`).not.toBe(definition.id);
      }
    }
  });

  it('resolves the built-in choice — and no choice at all — to the built-in name', () => {
    expect(skinDisplayName(en, BUILTIN_SKIN)).toBe(en.common.skinBuiltIn);
    expect(skinDisplayName(en, null)).toBe(en.common.skinBuiltIn);
    expect(skinDisplayName(en, 'studio-oled')).toBe('Studio OLED');
  });
});

// A shared stylesheet has no directory name to be scoped by, so the per-skin guard above cannot reach it:
// it reads exactly one file per SKINS entry and never walks the skins/ tree. These checks close that hole
// against the family declaration in lib/skins.ts, which is the only place that says which ids such a file
// is allowed to target.
describe('shared family stylesheets', () => {
  const index = readFileSync(join(root, 'skins', 'index.css'), 'utf-8');
  const sheets = SKIN_FAMILY_SHEETS.flatMap(({ family, members, sharedStylesheets }) =>
    sharedStylesheets.map((path) => ({ family, members, path })),
  );

  it('declares at least one shared stylesheet, over real skins, with no id in two families', () => {
    // A declaration that describes nothing passes every check below forever.
    expect(sheets.length, 'no shared stylesheet is declared — the guard would scan nothing').toBeGreaterThan(0);
    const claimed: string[] = [];
    for (const { family, members } of SKIN_FAMILY_SHEETS) {
      expect(members.length, `family "${family}" has no members`).toBeGreaterThan(0);
      for (const member of members) {
        expect(SKINS as readonly string[], `family "${family}" claims unknown skin "${member}"`).toContain(member);
        expect(claimed, `skin "${member}" belongs to two families`).not.toContain(member);
        claimed.push(member);
      }
    }
  });

  it('imports every shared stylesheet from skins/index.css exactly once, and nothing else', () => {
    for (const { path } of sheets) {
      const line = `@import "./${path}";`;
      expect(readFileSync(join(root, 'skins', path), 'utf-8').length, `${path} is empty`).toBeGreaterThan(0);
      expect(index.split(line).length - 1, `${path} must be imported exactly once from index.css`).toBe(1);
    }
    // Both directions: a shared file added and never imported ships nothing, a file imported without
    // being declared is CSS no guard covers. The per-skin @imports are pinned by the registry test above.
    const imported = [...index.matchAll(/@import "\.\/([^"]+)";/g)].map((m) => m[1]!);
    const expected = [...SKINS.map((skin) => `${skin}/skin.css`), ...sheets.map((s) => s.path)];
    expect(imported.sort()).toEqual(expected.sort());
  });

  it('scopes every shared rule to its own family, and never reaches outside it', () => {
    for (const { family, members, path } of sheets) {
      const fragments = selectorFragments(readFileSync(join(root, 'skins', path), 'utf-8'));
      expect(fragments.length, `${path} has no rules`).toBeGreaterThan(0);
      const outsiders = (SKINS as readonly string[]).filter((id) => !(members as readonly string[]).includes(id));
      const targeted = new Set<string>();

      for (const part of fragments) {
        // Reaching outside the family is reported first: a rule scoped to the wrong skin IS scoped, and
        // calling it unscoped would send the reader looking for a missing attribute that is right there.
        for (const outsider of outsiders) {
          expect(part, `${path} targets "${outsider}", which is outside family "${family}": "${part}"`)
            .not.toContain(`[data-skin='${outsider}']`);
        }
        const hit = members.filter((id) => part.includes(`[data-skin='${id}']`));
        // Unscoped here is exactly as bad as unscoped in a skin.css: the rule applies to every instance.
        expect(hit.length, `unscoped selector in ${path}: "${part}"`).toBeGreaterThan(0);
        for (const id of hit) targeted.add(id);
      }

      // Across the file as a whole, every member must be targeted by something. A variant that no shared
      // rule reaches is a half-added skin: it inherits the palette and none of the structure.
      expect([...targeted].sort(), `${path} never targets every member of family "${family}"`)
        .toEqual([...members].sort());
    }
  });
});

// The app ships TWO looks. It used to ship three: `studio-light`, `studio-oled`, and the design a
// document wore when it carried no `data-skin` at all — the pre-skins Ember palette on the ambient
// shell. Nothing selected that third one on purpose and every fallback landed on it by accident, which
// is the worst way for a design to be reachable. These checks are what keep it gone.
describe('the app has exactly two designs', () => {
  it('compiles exactly the two Studio variants', () => {
    // Pinned by value rather than by count. A deployment fork that genuinely adds a design updates this
    // line, which is the point: adding a third look is a decision, not a side effect of adding a folder.
    expect([...SKINS]).toEqual(['studio-light', 'studio-oled']);
    expect(SKINS as readonly string[], 'DEFAULT_SKIN has to be one of them').toContain(DEFAULT_SKIN);
  });

  it('resolves every possible input to a compiled skin, never to nothing', () => {
    // The whole matrix of things that used to produce null: nothing chosen, the compatibility name, a
    // retired name, a name no build ever had, an empty allow-list, an unset ELOWEN_SKIN, and every
    // combination of those with a deployment default.
    const lists: (readonly SkinChoice[])[] = [[], [BUILTIN_SKIN], [...SKINS], ['studio-oled']];
    const chosen = [null, undefined, '', BUILTIN_SKIN, 'midnight', 'ghost', '../etc', 'studio-light', 'studio-oled'];
    const fallbacks: (SkinName | null)[] = [null, 'studio-light', 'studio-oled'];
    for (const allowed of lists) {
      for (const choice of chosen) {
        for (const fallback of fallbacks) {
          const resolved = resolveSkin(choice, allowed, fallback);
          expect(SKINS as readonly string[], `resolveSkin(${JSON.stringify(choice)}, [${allowed}], ${fallback}) escaped the two designs`)
            .toContain(resolved);
        }
      }
    }
  });

  it('mounts one shell presentation, whatever the document is wearing', () => {
    // `spatial` is still a declarable profile — a fork adding an ambient design names it in its own
    // SKIN_DEFINITIONS entry — but no input to THIS build can reach it, because everything that is not a
    // compiled skin reads DEFAULT_SKIN's profile and every compiled skin is Studio. A third look cannot
    // come back through the shell seam while the palette stays put.
    const expected = SKIN_DEFINITIONS[DEFAULT_SKIN].shellProfile;
    expect(expected).toBe('command');
    for (const skin of SKINS) expect(shellProfileFor(skin), `${skin} mounts another shell`).toBe(expected);
    for (const absent of [null, undefined, BUILTIN_SKIN] as const) {
      expect(shellProfileFor(absent), `${absent} mounts another shell`).toBe(expected);
    }
  });

  it('names one family, so a shared stylesheet reaches every design there is', () => {
    // Two variants of one design rather than two designs is what makes "exactly two looks" honest: the
    // structure lives in skins/studio/*.css and is scoped to both ids, so neither variant can drift into
    // a third shape without leaving the family behind.
    const families = new Set(Object.values(SKIN_DEFINITIONS).map((definition) => definition.family));
    expect([...families]).toEqual(['studio']);
  });
});

describe('skin choice resolution', () => {
  const allowed = allowedSkinChoices([BUILTIN_SKIN, 'studio-light', 'studio-oled']);

  it('offers only compiled designs, in operator order, without the duplicate default alias', () => {
    expect(allowedSkinChoices(['studio-oled', BUILTIN_SKIN, 'studio-light'])).toEqual(['studio-oled', 'studio-light']);
    // A name left behind by a deployment that used to ship a skin would otherwise be offered as an
    // option that visibly does nothing. The placeholder is deliberately one no build can ever compile:
    // this file is inherited by deployment forks that DO add skins of their own, and naming a real one
    // here would fail there for the wrong reason.
    expect(allowedSkinChoices(['not-a-compiled-skin', 'studio-oled'])).toEqual(['studio-oled']);
    expect(allowedSkinChoices(['studio-oled', 'studio-oled'])).toEqual(['studio-oled']);
    expect(allowedSkinChoices(null)).toEqual([]);
  });

  it('honours an allowed design and safely resolves the compatibility alias', () => {
    expect(resolveSkin('studio-oled', allowed, null)).toBe('studio-oled');
    // The alias is no longer offered, so stored legacy data follows the deployment fallback.
    expect(resolveSkin(BUILTIN_SKIN, allowed, 'studio-oled')).toBe('studio-oled');
    // The resolver still understands explicitly admitted legacy data for compatibility callers.
    expect(resolveSkin(BUILTIN_SKIN, [BUILTIN_SKIN], 'studio-oled')).toBe(DEFAULT_SKIN);
  });

  it('drops a choice the admin has revoked, back to the deployment default', () => {
    // This is what makes the allow-list a control rather than a suggestion: nobody has to reach into a
    // stored value for a revocation to take effect on the next document.
    expect(resolveSkin('studio-oled', allowedSkinChoices([BUILTIN_SKIN]), 'studio-oled')).toBe('studio-oled');
    expect(resolveSkin('ghost', allowed, 'studio-oled')).toBe('studio-oled');
    expect(resolveSkin(null, allowed, 'studio-oled')).toBe('studio-oled');
    // Nothing left to fall to: DEFAULT_SKIN is the floor, never null.
    expect(resolveSkin('studio-oled', [], null)).toBe(DEFAULT_SKIN);
  });

  it('starts the cycle from what is actually on screen', () => {
    expect(currentSkinChoice('studio-oled', allowed, null)).toBe('studio-oled');
    // Nothing chosen: the visible design is the operator's default, and that is where cycling starts.
    expect(currentSkinChoice(null, allowed, 'studio-oled')).toBe('studio-oled');
    expect(currentSkinChoice(null, allowed, null)).toBe(DEFAULT_SKIN);
    // The deployment default is not itself on offer — cycling must not claim it was picked.
    expect(currentSkinChoice(null, allowedSkinChoices([BUILTIN_SKIN]), 'studio-oled')).toBeNull();
  });

  it('cycles forward and wraps, and starts at the first entry from nothing', () => {
    expect(nextSkinChoice(BUILTIN_SKIN, allowed)).toBe('studio-light');
    expect(nextSkinChoice('studio-light', allowed)).toBe('studio-oled');
    expect(nextSkinChoice('studio-oled', allowed)).toBe('studio-light');
    expect(nextSkinChoice(null, allowed)).toBe('studio-light');
    expect(nextSkinChoice(null, [])).toBeNull();
  });
});
