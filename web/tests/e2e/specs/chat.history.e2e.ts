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
