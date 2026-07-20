// P0-5 — scroll-up lazy-load of chat history over the real pagination cursor. The initial page shows the
// newest turns with the sentinel present (older history remains); scrolling to the top trips loadOlder,
// which PREPENDS the older page exactly once (no duplication) and clears the sentinel once the cursor
// reaches null (nextBefore === null).
import { test, expect, ChatPage } from '../fixtures/index.ts';
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
