import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { createWrapper } from '../test-utils';

/** `usePluginStrings` hands a bundle the copy its own manifest declares, and the /plugins/ui listing
 *  that carries it arrives over the network. For the paint or two before it lands the record is empty,
 *  and a view that FORMATS its copy — `s.someKey.replace('{n}', …)`, which several moved views do —
 *  would not render a blank label there: it would throw on `undefined` and take the whole page down
 *  over a string that was one round-trip away.
 *
 *  So the record is total: an unknown key reads as the empty string. Catching a genuinely missing key
 *  is the job of the static guards (tests/contract/pluginBundleStringKeys.test.ts and
 *  scripts/check-languages.mjs) — throwing here would not find one any earlier, only in front of a user. */

ensurePluginUiRuntime();

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

interface Hooks { usePluginStrings(plugin: string): Record<string, string> }
const hooks = (window as unknown as { ElowenUiRuntime: { hooks: Hooks } }).ElowenUiRuntime.hooks;

/** A view shaped like the real ones: it interpolates its copy instead of only interpolating a value. */
function FormattingView() {
  const s = hooks.usePluginStrings('work');
  return <p data-testid="out">{s.tlActivityHours.replace('{n}', '12')}</p>;
}

describe('usePluginStrings', () => {
  it('does not throw while the listing is still loading', () => {
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([])));
    const { wrapper: Wrapper } = createWrapper();
    // Would be a TypeError ("Cannot read properties of undefined (reading 'replace')") if the record
    // were a plain object — the whole page, gone, for the duration of one request.
    expect(() => render(<Wrapper><FormattingView /></Wrapper>)).not.toThrow();
    expect(screen.getByTestId('out').textContent).toBe('');
  });

  it('serves the plugin its own strings once the listing resolves', async () => {
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([
      { name: 'work', url: '/x.js', apiVersion: 1, nav: [], settings: [], strings: { tlActivityHours: 'last {n} hours' } },
      { name: 'other', url: '/y.js', apiVersion: 1, nav: [], settings: [], strings: { tlActivityHours: 'WRONG PLUGIN' } },
    ])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><FormattingView /></Wrapper>);
    expect(await screen.findByText('last 12 hours')).toBeTruthy();
  });
});
