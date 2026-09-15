// The chat picture opened full size: the image alone on a calm backdrop, sized to the viewport it was
// opened in.
//
// None of this is checkable in jsdom, which lays nothing out and hit-tests nothing. Three things in
// particular only a real browser can answer, and each is a silent failure a unit test would sail past:
//
//  1. The card material is taken back off the surface by an UNSIGNED, UNLAYERED CSS rule
//     (`.overlay-surface[data-chrome='bare']`) that outranks the Tailwind utilities the dialog primitive
//     itself carries. If the cascade were the other way round the lightbox would still be a card, and
//     every jsdom class assertion would still pass. Computed styles are the proof.
//  2. `max-h-full` / `max-w-full` only cap the picture if the surface's height is definite, and the
//     safe-area padding only keeps the notch off it if the backdrop really pads. Measured boxes, both.
//  3. The box the browser hit-tests has to END WHERE THE PAINTED PICTURE ENDS. The fixture is 2000×1200
//     — larger than every viewport below — so the picture is shrunk, and a click inside its painted edge
//     must keep it open while a click on the scrim beside it closes it.
import { test, expect } from '../fixtures/index.ts';
import type { Locator, Page } from '@playwright/test';
import { ChatPage } from '../pages/ChatPage.ts';

const PICTURE = '/api/brain/chat-images/lightbox.png';
/** What the fixture declares, so the shrunk box can be checked against its own proportions. */
const RATIO = 2000 / 1200;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
] as const;

/** The lightbox states its name instead of showing one. */
const VIEWER = /image preview|náhled obrázku|náhľad obrázka/i;

for (const viewport of VIEWPORTS) {
  test(`the full-size picture stands alone and fits the ${viewport.name} viewport`, async ({ app, seed, sse }, testInfo) => {
    test.setTimeout(90_000);
    await app.setViewportSize({ width: viewport.width, height: viewport.height });
    await seed.messages([]);
    await new ChatPage(app).goto();

    await sse.emit({ type: 'image', ref: PICTURE });
    const thumb = app.locator(`button:has(img[src="${PICTURE}"])`).first();
    await expect(thumb).toBeVisible();

    // The thumbnail is still a thumbnail: capped on the frame, with the picture filling it.
    const thumbBox = (await thumb.locator('img').boundingBox())!;
    const frameBox = (await thumb.boundingBox())!;
    expect(thumbBox.height).toBeLessThanOrEqual(192 + 1); // max-h-48
    expect(thumbBox.width).toBeLessThanOrEqual(Math.min(256, viewport.width) + 1); // max-w-[min(16rem,100%)]
    // The frame is the picture plus its 1px border on each side: no border hanging around empty space.
    expect(frameBox.width - thumbBox.width).toBeLessThanOrEqual(3);

    await thumb.click();
    const surface = app.getByRole('dialog', { name: VIEWER });
    await expect(surface).toBeVisible();
    const image = app.getByTestId('image-lightbox');
    await expect(image).toBeVisible();
    const box = await settledBox(app, image);

    // Enlarged, whole, and inside the viewport on every edge.
    expect(box.height).toBeGreaterThan(thumbBox.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(Math.abs(box.width / box.height - RATIO)).toBeLessThan(0.01);
    // It takes the room it is given too — capped by one axis of the viewport, not left small.
    expect(Math.max(box.width / viewport.width, box.height / viewport.height)).toBeGreaterThan(0.85);

    // Nothing drawn around it. The shared dialog material is declined, and only the computed style says so.
    const paint = await surface.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        shadow: s.boxShadow,
        borderTopWidth: s.borderTopWidth,
        borderTopLeftRadius: s.borderTopLeftRadius,
      };
    });
    expect(paint.background).toBe('rgba(0, 0, 0, 0)');
    expect(paint.shadow).toBe('none');
    expect(paint.borderTopWidth).toBe('0px');
    expect(paint.borderTopLeftRadius).toBe('0px');
    // No header, no title, no close control, no caption: the surface holds the picture and nothing else.
    await expect(surface.locator('h1, h2, h3, h4, button, a, p')).toHaveCount(0);
    // What IS there is a calm ground covering the viewport, with the page behind it unscrollable.
    const backdrop = await surface.evaluate((el) => {
      const layer = el.parentElement!;
      const s = getComputedStyle(layer);
      return { background: s.backgroundColor, width: layer.getBoundingClientRect().width, height: layer.getBoundingClientRect().height };
    });
    expect(backdrop.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(backdrop.width).toBeCloseTo(viewport.width, 0);
    expect(backdrop.height).toBeCloseTo(viewport.height, 0);
    expect(await app.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');

    // What the reader sees at this size, kept with the run's report.
    await testInfo.attach(`lightbox-${viewport.name}.png`, {
      body: await app.screenshot(),
      contentType: 'image/png',
    });

    // The hit box is the painted picture: a press inside its own drawn edge keeps the lightbox open…
    await app.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
    await expect(surface).toBeVisible();
    await expect(image).toBeVisible();

    // …and a press on the empty band BESIDE the picture closes it. The band has to be inside the surface's
    // own box, not on the scrim ring: that is precisely where the click used to die, because Radix states
    // `pointer-events: auto` INLINE on the dialog content, a class on the surface cannot beat it, and the
    // surface then captured the press and stopped it from reaching the backdrop. A click at (2,2) is
    // outside the surface and passed even while that was broken, so it proves nothing on its own.
    const surfaceBox = (await surface.boundingBox())!;
    const beside = middleOfBand(surfaceBox, box);
    expect(beside.x >= surfaceBox.x && beside.x <= surfaceBox.x + surfaceBox.width).toBe(true);
    expect(beside.y >= surfaceBox.y && beside.y <= surfaceBox.y + surfaceBox.height).toBe(true);
    expect(beside.x < box.x || beside.x > box.x + box.width || beside.y < box.y || beside.y > box.y + box.height).toBe(true);
    await app.mouse.click(beside.x, beside.y);
    await expect(surface).toHaveCount(0);

    // The scrim outside the surface closes it the same way.
    await thumb.click();
    await expect(surface).toBeVisible();
    await app.mouse.click(2, 2);
    await expect(surface).toHaveCount(0);

    // Escape closes it the same way and hands focus back to the thumbnail it came from.
    await thumb.click();
    await expect(surface).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(surface).toHaveCount(0);
    await expect
      .poll(() => app.evaluate(() => document.activeElement?.matches('button:has(img[src])') ?? false))
      .toBe(true);
  });
}

/** The middle of the empty band beside the picture, inside the surface's own box. The picture is capped by
 *  whichever axis the viewport is short on, so the band is on the other one. */
function middleOfBand(
  surface: { x: number; y: number; width: number; height: number },
  picture: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const gapX = picture.x - surface.x;
  const gapY = picture.y - surface.y;
  return gapX > gapY
    ? { x: surface.x + gapX / 2, y: surface.y + surface.height / 2 }
    : { x: surface.x + surface.width / 2, y: surface.y + gapY / 2 };
}

/** The box the reader finally sees. Measuring the first one is not enough here for two reasons: the shared
 *  dialog entrance (`animate-pop-in`) scales the surface for a beat, and a vector picture has no intrinsic
 *  size until it decodes, so the element starts at nothing and grows. Read until it stops moving. */
async function settledBox(page: Page, locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  let last = (await locator.boundingBox())!;
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.waitForTimeout(50);
    const next = (await locator.boundingBox())!;
    if (next.x === last.x && next.y === last.y && next.width === last.width && next.height === last.height) return next;
    last = next;
  }
  return last;
}
