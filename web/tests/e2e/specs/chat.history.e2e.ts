// P0-5 — scroll-up lazy-load of chat history over the real pagination cursor. The initial page shows the
// newest turns with the sentinel present (older history remains); scrolling to the top trips loadOlder,
// which PREPENDS the older page exactly once (no duplication) and clears the sentinel once the cursor
// reaches null (nextBefore === null).
import { test, expect, ChatPage } from '../fixtures/index.ts';
import { DAEMON_URL } from '../fixtures/env.ts';
import type { BrainMessage } from '../../../lib/types.ts';

// The provider fetches the newest HISTORY_PAGE (50) turns first; a source larger than that leaves an
// older page behind, so the sentinel shows and one scroll-up loads the remainder.
const TOTAL = 60;
const seedTurns: BrainMessage[] = Array.from({ length: TOTAL }, (_, i) =>
  i % 2 === 0
    ? { id: `m${i}`, role: 'user', text: `Msg ${i} (you)` }
    : { id: `m${i}`, role: 'assistant', text: `Msg ${i} (elowen)`, segments: [{ kind: 'text', text: `Msg ${i} (elowen)` }] },
);

test('@smoke P0-5 scrolling to the top lazy-loads older history once, then retires the sentinel', async ({ app, seed }) => {
  await seed.messages(seedTurns);

  const chat = new ChatPage(app);
  await chat.goto();

  // Initial page: the newest 50 turns, with the sentinel present (10 older turns remain). The oldest
  // turn is NOT rendered yet.
  await expect(chat.turns()).toHaveCount(50);
  await expect(chat.historySentinel).toBeVisible();
  await expect(chat.turns().filter({ hasText: 'Msg 0 (you)' })).toHaveCount(0);

  // Scroll to the top → loadOlder prepends the remaining 10 turns.
  await chat.scrollToTopForOlder();

  await expect(chat.turns()).toHaveCount(TOTAL);
  await expect(chat.turns().filter({ hasText: 'Msg 0 (you)' })).toHaveCount(1);
  // Cursor exhausted (nextBefore === null) → the sentinel is gone.
  await expect(chat.historySentinel).toHaveCount(0);

  // A second scroll-up is a no-op — no further page, no duplicated turns.
  await chat.scrollToTopForOlder();
  await expect(chat.turns()).toHaveCount(TOTAL);
  await expect(chat.turns().filter({ hasText: 'Msg 0 (you)' })).toHaveCount(1);
});

test('opening a chat and growing its composer keep the newest message in view', async ({ app, seed }) => {
  await seed.messages(seedTurns);
  const chat = new ChatPage(app);
  await chat.goto();
  await expect(chat.lastTurn()).toContainText('Msg 59 (elowen)');

  const bottomGap = () => app.locator('main').evaluate((main) => main.scrollHeight - main.scrollTop - main.clientHeight);
  // The dock's bottom safe-area padding intentionally leaves a small non-zero gap.
  await expect.poll(bottomGap, { message: 'the opened conversation did not start at its newest message' }).toBeLessThan(32);

  await chat.composer.fill(Array.from({ length: 8 }, (_, i) => `Wrapped line ${i + 1}`).join('\n'));
  await expect.poll(bottomGap, { message: 'growing the composer moved the newest message out of view' }).toBeLessThan(32);

  await app.getByRole('button', { name: /Conversation history|Historie konverzací/i }).click();
  await app.getByRole('button', { name: 'Second conversation' }).click();
  await expect.poll(async () => {
    const response = await app.request.get(`${DAEMON_URL}/__test/streams?session=brain-2`);
    const body = await response.json() as { streams: unknown[] };
    return body.streams.length;
  }, { message: 'the selected conversation never became the active stream' }).toBeGreaterThan(0);
  await expect.poll(bottomGap, { message: 'switching conversations kept the previous scroll offset' }).toBeLessThan(32);
});

// Entering /chat is a LAYOUT guarantee, not a timing one: however many frames the transcript takes to
// settle, the newest turn ends up at the bottom. Both halves of the defect this covers were races between
// a pin write and the `scroll` event that write fires — the shell <main> outlives a route change, so it
// carries the previous page's offset into the surface's first layout, and the transcript is still short at
// that moment. Whichever handler won decided where the conversation opened, so it opened somewhere
// different each time and sometimes at the top.
test('every entry to /chat opens on the newest turn without tripping the older-history loader', async ({ app, seed }) => {
  await seed.messages(seedTurns);
  const chat = new ChatPage(app);
  // The dock's bottom safe-area padding intentionally leaves a small non-zero gap.
  const bottomGap = () => app.locator('main').evaluate((main) => main.scrollHeight - main.scrollTop - main.clientHeight);

  // Repeated on purpose. A single visit passed even while the bug was live; what it never did was pass
  // four times running, because each entry raced differently.
  for (const visit of [1, 2, 3, 4]) {
    await chat.goto();
    await expect(chat.lastTurn(), `visit ${visit}`).toContainText('Msg 59 (elowen)');
    // The loader must not fire on ENTRY. The pin's own write lands within the trigger distance of the top
    // while the transcript is still shorter than the viewport, and that is not the reader asking to read
    // upwards — the prepend that followed held its position instead of going to the newest turn, which is
    // how the conversation opened mid-history.
    await expect(chat.turns(), `visit ${visit} lazy-loaded older history on its own`).toHaveCount(50);
    await expect(chat.historySentinel, `visit ${visit} consumed the older page on its own`).toBeVisible();
    await expect.poll(bottomGap, { message: `visit ${visit} did not open on the newest turn` }).toBeLessThan(32);

    await app.goto('/dash');
    await expect(app.locator('h1')).toBeVisible();
  }
});

// The other side of the same invariant: the pin follows real layout only while the reader is still at the
// bottom. A reader who has scrolled up to read history owns the offset until they come back down.
//
// Run for each desktop way a reader can start a scroll, because they do not all emit the same event and the
// pin is released on the INPUT, not on the offset. Native scrollbar interaction emits no wheel, touch or key,
// and `<main>` carries a permanent gutter — using that control was the gesture that still got yanked back to
// the newest turn.
for (const gesture of ['wheel', 'keyboard', 'pointerdown'] as const) {
test(`a reader who scrolled up with ${gesture} is not dragged back down by a streaming delta`, async ({ app, seed, sse }) => {
  await seed.messages(seedTurns);
  const chat = new ChatPage(app);
  await chat.goto();
  await expect(chat.lastTurn()).toContainText('Msg 59 (elowen)');

  // Use the browser's real input path. A bare programmatic scroll is indistinguishable from the surface's
  // own write and must NOT count as reader intent.
  const main = app.locator('main');
  const box = await main.boundingBox();
  if (!box) throw new Error('chat scroller has no bounding box');
  if (gesture === 'wheel') {
    await main.hover({ position: { x: box.width / 2, y: box.height / 2 } });
    await app.mouse.wheel(0, -600);
  } else if (gesture === 'keyboard') {
    await app.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await app.keyboard.press('PageUp');
  } else {
    // Click the stable vertical scrollbar gutter above its bottom-positioned thumb. This exercises the native
    // pointer route and scrolls upward without synthesizing either event or offset.
    await app.mouse.click(box.x + box.width - 2, box.y + box.height * 0.35);
  }
  const readingAt = await app.locator('main').evaluate((main) => main.scrollTop);
  expect(readingAt, 'the reader is genuinely scrolled up').toBeGreaterThan(0);

  // Growth below the viewport: a new turn streams in while they read.
  await sse.user('A question that arrives while the reader is up in the history');
  await sse.deltas('And a long answer streaming in underneath it, growing the transcript as it goes.');
  await expect(chat.turns()).toHaveCount(52);

  // The transcript grew, so the offset may not be identical — but the reader must still be up in the
  // history, nowhere near the bottom the pin would have snapped them to.
  const gap = await app.locator('main').evaluate((main) => main.scrollHeight - main.scrollTop - main.clientHeight);
  expect(gap, 'a streaming delta yanked the reader back down to the newest turn').toBeGreaterThan(32);
});
}
