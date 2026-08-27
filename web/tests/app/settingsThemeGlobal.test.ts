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
