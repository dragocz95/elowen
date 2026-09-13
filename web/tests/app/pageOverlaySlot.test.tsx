import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { render } from '@testing-library/react';
import PageOverlayCatchAll from '../../app/@pageOverlay/[...catchAll]/page';
import PageOverlayDefault from '../../app/@pageOverlay/default';

const WEB = resolve(process.cwd());
const APP = join(WEB, 'app');
const SLOT = join(APP, '@pageOverlay');

/** The intercepted presentation rests on three Next conventions that no type checks and no unit test of a
 *  component can see, and getting any of them wrong fails SILENTLY — the overlay simply never appears, or
 *  never goes away:
 *
 *   - the slot directory's name has to match the prop the root layout destructures;
 *   - every route the slot does not intercept has to render nothing, or the last overlay stays on screen
 *     after navigating away;
 *   - an interceptor has to exist for each page presented this way, and for no other route. */
describe('app/@pageOverlay slot', () => {
  it('intercepts exactly the pages presented as overlays', () => {
    const routes = readdirSync(SLOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(routes).toEqual(['(.)account', '(.)settings', '[...catchAll]']);
    // Each interceptor names a canonical page that really exists underneath it.
    for (const route of ['account', 'settings']) {
      expect(readdirSync(join(APP, route))).toContain('page.tsx');
    }
  });

  it('is read by the root layout under the slot directory name', () => {
    const layout = readFileSync(join(APP, 'layout.tsx'), 'utf8');
    // Next passes a parallel slot as a prop named after its directory; a rename of one without the other
    // leaves the layout receiving `undefined` forever.
    expect(layout).toContain('pageOverlay');
    expect(layout).not.toContain('settingsOverlay');
  });

  it('renders nothing for a hard load and for any route it does not intercept', () => {
    expect(render(<PageOverlayDefault />).container).toBeEmptyDOMElement();
    expect(render(<PageOverlayCatchAll />).container).toBeEmptyDOMElement();
  });

  /** Interception happens on a CLIENT navigation only. A plain `<a href="/account">` inside the app
   *  therefore reloads the document and lands on the canonical page, which is the one door of several
   *  that behaves differently from the rest — and it looks identical in review. Both cross-links between
   *  these two pages were exactly that before their overlay landed. */
  it('is reached from inside the app through client navigation only', () => {
    const rawLink = /<a\s[^>]*href="\/(account|settings)/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); continue; }
        if (!entry.name.endsWith('.tsx')) continue;
        if (rawLink.test(readFileSync(path, 'utf8'))) offenders.push(relative(WEB, path));
      }
    };
    for (const dir of ['app', 'components', 'modules']) walk(resolve(WEB, dir));
    expect(offenders).toEqual([]);
  });
});
