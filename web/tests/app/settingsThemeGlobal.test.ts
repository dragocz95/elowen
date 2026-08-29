import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const webRoot = join(import.meta.dirname, '..', '..');

/** The settings surface is shared UI: /settings renders it, /account renders it, and every plugin bundle
 *  is handed the same components through `web/lib/pluginUi.tsx`. It used to live in a module stylesheet
 *  that the ROOT LAYOUT had to import by hand so plugin routes got it too — a core stylesheet in all but
 *  location. It is one of the core component stylesheets now, so no route has to remember it. */
describe('settings surface stylesheet ownership', () => {
  it('ships the surface from the core stylesheet tree, not a module theme file', () => {
    expect(existsSync(join(webRoot, 'modules', 'settings', 'theme.css'))).toBe(false);
    expect(existsSync(join(webRoot, 'modules', 'account', 'theme.css'))).toBe(false);

    const layout = readFileSync(join(webRoot, 'app', 'layout.tsx'), 'utf8');
    const settingsPage = readFileSync(join(webRoot, 'app', 'settings', 'page.tsx'), 'utf8');
    const accountPage = readFileSync(join(webRoot, 'app', 'account', 'page.tsx'), 'utf8');
    for (const source of [layout, settingsPage, accountPage]) expect(source).not.toContain('theme.css');

    const css = readFileSync(join(webRoot, 'app', 'styles', 'components', 'spatial-deck.css'), 'utf8');
    for (const rule of ['.settings-document', '.settings-group', '.settings-row', '.settings-toolbar']) {
      expect(css).toContain(rule);
    }
  });

  /** /account carried a second card convention — `[data-account-panel]` drew its own frame and
   *  `.spatial-form-group` its own inner group — beside the `.settings-group` it also used. Two card
   *  languages on one page is how the two pages stopped reading as one product. */
  it('keeps one card convention: no account-only rival of .settings-group', () => {
    const css = readFileSync(join(webRoot, 'app', 'styles', 'components', 'spatial-deck.css'), 'utf8');
    expect(css).not.toContain('spatial-form-group');
    expect(css).not.toMatch(/\[data-account-panel\][^{]*\{[^}]*(border|box-shadow|background)/);
  });
});

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first brace block whose prelude contains `needle`, brace-matched so a container
 *  query's own nested rules come back with it. A regex cannot do this: `[^}]*` stops at the first
 *  nested closing brace, which is exactly where these assertions need to start looking. */
function block(css: string, needle: string): string {
  const at = css.indexOf(needle);
  expect(at, `no block matching ${needle}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block for ${needle}`);
}

/** THE ROW LAYOUT CONTRACT, asserted against the stylesheets because that is where it lives: a record is
 *  one grid row on a wide card and a two-line band in a narrow container, and never three lines in
 *  either. The DOM/source half of the same contract is in tests/modules/settings/SettingsSurface.test.tsx.
 *
 *  Both sheets are checked. The base one states the rule; the Studio skin is more specific than it by
 *  construction (`:root:is([data-skin=…])` outranks a bare class), so a base rule the skin does not
 *  restate is a rule that does not apply on the default design — which is how the phone layout drifted
 *  the last time. */
describe('settings row layout contract', () => {
  const core = stripComments(readFileSync(join(webRoot, 'app', 'styles', 'components', 'spatial-deck.css'), 'utf8'));
  const studio = stripComments(readFileSync(join(webRoot, 'skins', 'studio', 'surfaces.css'), 'utf8'));
  const PHONE = '@container workspace-shell (width < 38.75rem)';

  // Leading newline: `.settings-row {` on its own also ends `.settings-group__panel .settings-row {`,
  // which is a different rule about a record nested in a padded panel.
  const BASE_ROW = '\n.settings-row {';

  it('gives every record the same floor so a card reads as evenly ruled', () => {
    expect(block(core, BASE_ROW)).toMatch(/min-height:\s*2\.75rem/);
  });

  it("never wraps an inline record's trailing cell, at any width", () => {
    // Declared outside every container query, so it holds on a 1440px card and on a 320px one alike.
    expect(block(core, ".settings-row[data-trailing='inline'] .settings-row__trailing {")).toMatch(/flex-wrap:\s*nowrap/);
    expect(block(studio, ".settings-row[data-trailing='inline'] .settings-row__trailing {")).toMatch(/flex-wrap:\s*nowrap/);
  });

  it('folds every record to the two-line band in a narrow container', () => {
    expect(block(block(core, PHONE), '\n  .settings-row {')).toMatch(/grid-template-columns:\s*1fr/);
    // `[data-trailing]` matches every record, inline and stack alike. It used to read `[data-trailing='stack']`
    // here, which left a one-value record holding a two-column table inside ~120px.
    expect(block(block(studio, PHONE), '.settings-row[data-trailing] {')).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(block(block(studio, PHONE), '.settings-row[data-trailing] .settings-row__label,')).toMatch(/grid-column:\s*1/);
  });

  it("raises the record's controls to a touch target for a coarse pointer", () => {
    const coarse = block(core, '@media (pointer: coarse)');
    for (const control of ['button', "[role='combobox']", "[role='radio']", "[role='switch']"]) {
      expect(coarse).toContain(`.settings-row__trailing ${control}`);
    }
    expect(coarse).toMatch(/min-height:\s*2\.75rem/);
  });
});
