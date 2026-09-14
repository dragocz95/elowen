import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import PageOverlayCatchAll from '../../app/@pageOverlay/[...catchAll]/page';
import PageOverlayDefault from '../../app/@pageOverlay/default';
import InterceptedAccountPage from '../../app/@pageOverlay/(.)account/page';
import InterceptedSettingsPage from '../../app/@pageOverlay/(.)settings/page';
import AccountSlotPage from '../../app/@pageOverlay/account/page';
import SettingsSlotPage from '../../app/@pageOverlay/settings/page';
import AccountPage from '../../app/account/page';
import SettingsPage from '../../app/settings/page';

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
  it('intercepts exactly the pages presented as overlays, and answers a hard load for each', () => {
    const routes = readdirSync(SLOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    // The interceptor answers a CLIENT navigation; the plain route beside it answers a hard load, where
    // nothing is intercepted. Without the second one the slot is empty on arrival and the canonical page
    // underneath is the whole screen — a different presentation of the same address.
    expect(routes).toEqual(['(.)account', '(.)settings', '[...catchAll]', 'account', 'settings']);
    // Each interceptor names a canonical page that really exists underneath it.
    for (const route of ['account', 'settings']) {
      expect(readdirSync(join(APP, route))).toContain('page.tsx');
    }
  });

  /** ONE presentation, whichever way the reader arrived. The interceptor and the plain route are two
   *  Next conventions for two arrivals at the same address, so they have to answer with the same
   *  component — a second overlay component behind one of them is exactly the drift this pins. */
  it('answers an intercepted navigation and a hard load with the same overlay', () => {
    expect((SettingsSlotPage() as ReactElement).type).toBe((InterceptedSettingsPage() as ReactElement).type);
    expect((AccountSlotPage() as ReactElement).type).toBe((InterceptedAccountPage() as ReactElement).type);
  });

  /** The canonical page owns the ADDRESS, not the presentation: the slot above is what draws Settings and
   *  Account, so the page underneath contributes no content of its own. Rendering the deck here as well is
   *  what put a standalone page on screen for a hard load, and let it win the first frame of a client
   *  navigation before the intercepted overlay replaced it. */
  it('leaves the presentation to the slot on both canonical pages', () => {
    expect(render(<SettingsPage />).container).toBeEmptyDOMElement();
    expect(render(<AccountPage />).container).toBeEmptyDOMElement();
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
