import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sidebar = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'styles', 'components', 'sidebar-nav.css'), 'utf8');
const studio = readFileSync(join(import.meta.dirname, '..', '..', 'skins', 'studio', 'shared.css'), 'utf8');

/** SSR and the first hydrated commit do not know the measured workspace width, so a phone would paint a
 *  full navigation column across the content for one frame. The fail-safe that prevents it must stay
 *  pinned to the EXPLICIT unmeasured state and to the exact pixel complement of the shell's own
 *  breakpoint — a rem-based query would move with the reader's root font size and reopen the gap. */
describe('mobile shell first paint', () => {
  it('scopes the navigation fail-safe to the explicit unmeasured state and exact 1024px boundary', () => {
    const phone = sidebar.slice(sidebar.indexOf('@media (max-width: 1023px)'));
    expect(phone).toContain(".sidebar-nav[data-measured='false']:not([data-mode='drawer'])");
    expect(phone, 'leaves measured modes alone').not.toContain(`[data-measured='true']`);
    expect(phone).toMatch(/data-side='left'[^}]*transform:\s*translateX\(-100%\)/);
    expect(phone).toMatch(/data-side='right'[^}]*transform:\s*translateX\(100%\)/);
  });

  it('leaves the navigation out of the skins entirely', () => {
    // The column is the app's own component now. A skin that restated its geometry would be a second,
    // silently disagreeing layout owner the moment the shared stylesheet moved a number.
    // Comments may name the stylesheet that owns the column; a SELECTOR targeting it may not exist.
    const rules = studio.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toContain('.sidebar-nav');
    expect(rules).not.toContain('.studio-nav');
    expect(studio).not.toContain('@media (width < 64rem)');
  });
});
