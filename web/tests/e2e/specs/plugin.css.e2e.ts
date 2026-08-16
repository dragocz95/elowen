// A plugin must be able to bring its OWN stylesheet, and the app must apply it.
//
// Elowen is distributed as a PREBUILT web app (`web-dist/` ships in the package), so on a user's machine
// there is no Tailwind and no Next build: the host's CSS is frozen at publish time and carries only the
// utilities the HOST itself uses. Any utility a registry plugin reached for and the host did not — a
// `h-36`, a `grid-cols-[10rem_minmax(0,1fr)]` — simply did not exist there, and the plugin's page
// rendered unstyled with nothing the operator could do about it. The build-time class-mirroring the repo
// also has (`web/scripts/collect-plugin-classes.mjs`) only ever worked where the SOURCES are, which on a
// published install is nowhere.
//
// This is the end-to-end proof of the replacement pipe: the daemon advertises `cssUrl` in `/plugins/ui`,
// serves the sheet on its own immutable content-hash URL, and the app links it and WAITS for it before
// the plugin page resolves. It runs against the fake daemon and the REAL Next server, so what is measured
// is a real browser's computed style — the only place "is this rule actually applied" has an answer.
//
// The whole spec is one width the host cannot possibly have (137px, supplied only by the plugin sheet)
// plus a negative control (913px, supplied by nobody). Drop the `<link>` injection, drop `cssUrl` from
// the listing, or break the hash check in the serving route, and the probe reverts to its block default.
import { test, expect } from '../fixtures/index.ts';
import { PLUGIN_NAME, PLUGIN_LISTING, PROBE_WIDTH, CONTROL_WIDTH } from '../fake-daemon/handlers/plugins.ts';

/** The element's computed width in px. Read as a NUMBER and compared with a sub-pixel tolerance: the
 *  shell applies a UI zoom, so a rule that resolves to 137px measures as 136.987px in the real browser.
 *  The alternatives being distinguished here are hundreds of pixels apart, so the tolerance costs
 *  nothing — and a string compare would fail on styling that is demonstrably applied. */
const widthOf = (page: import('@playwright/test').Page, testId: string) =>
  page.locator(`[data-testid="${testId}"]`).evaluate((el) => parseFloat(getComputedStyle(el).width));

test('a plugin page paints with the stylesheet the plugin itself shipped', async ({ app, seed }, testInfo) => {
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell that hosts plugin pages');

  await seed.response('plugins/ui', PLUGIN_LISTING);
  await app.goto(`/p/${PLUGIN_NAME}`);

  const probe = app.locator('[data-testid="probe"]');
  await expect(probe).toBeAttached();

  // The utility exists ONLY in the sheet the plugin shipped. Its presence here is the entire claim.
  expect(await widthOf(app, 'probe')).toBeCloseTo(PROBE_WIDTH, 0);

  // Negative control. Without it the assertion above could be measuring an accident — a host stylesheet
  // that happens to carry arbitrary widths, or a repo-wide Tailwind scan that picked the class out of
  // this harness's own sources. This second div's class is in NEITHER sheet, so it must fall back to the
  // block default (the page width), and it must certainly not be its own arbitrary width.
  const control = await widthOf(app, 'control');
  expect(Math.abs(control - CONTROL_WIDTH)).toBeGreaterThan(1);
  expect(Math.abs(control - PROBE_WIDTH)).toBeGreaterThan(1);

  // And the proof that it is the PLUGIN's sheet doing the work, not something the host happens to carry:
  // detach that one link and the probe reverts. Without this, a stray occurrence of the class anywhere
  // Tailwind can read would make the host generate the rule and this spec would go green with the whole
  // pipe ripped out — which is precisely what a mutation run caught while this test was being written.
  await app.evaluate((href) => {
    for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
      if (link.href.includes(href)) link.remove();
    }
  }, PLUGIN_LISTING[0]!.cssUrl);
  expect(Math.abs(await widthOf(app, 'probe') - PROBE_WIDTH)).toBeGreaterThan(1);
});

test('the stylesheet is linked, served as text/css, and applied before the page resolves', async ({ app, seed }, testInfo) => {
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell that hosts plugin pages');

  const cssUrl = PLUGIN_LISTING[0]!.cssUrl;
  const responses: { url: string; type: string | undefined; status: number }[] = [];
  app.on('response', (res) => {
    if (res.url().includes(cssUrl)) responses.push({ url: res.url(), type: res.headers()['content-type'], status: res.status() });
  });

  await seed.response('plugins/ui', PLUGIN_LISTING);
  await app.goto(`/p/${PLUGIN_NAME}`);
  await expect(app.locator('[data-testid="probe"]')).toBeAttached();

  // The sheet was actually fetched, and with a MIME type a browser will apply — a stylesheet served as
  // anything else is downloaded and then ignored, which looks exactly like no stylesheet at all.
  expect(responses).toHaveLength(1);
  expect(responses[0]!.status).toBe(200);
  expect(responses[0]!.type).toContain('text/css');

  // The link is in the document, not merely fetched.
  const linked = await app.evaluate((href) => [...document.querySelectorAll('link[rel="stylesheet"]')]
    .some((l) => (l as HTMLLinkElement).href.includes(href)), cssUrl);
  expect(linked).toBe(true);

  // And the very FIRST frame that has the probe already has it styled: the loader waits for the sheet's
  // `load` before resolving the registration, so there is no paint of unstyled plugin markup in between.
  expect(await widthOf(app, 'probe')).toBeCloseTo(PROBE_WIDTH, 0);
});
