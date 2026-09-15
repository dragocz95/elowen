import { describe, expect, it } from 'vitest';
import { CodeModeCardFeed } from '../../src/brain/session/codeModeCard.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { BrainCard } from '../../src/brain/events.js';

function withEmitter<T>(fn: (cards: BrainCard[]) => T): T {
  const cards: BrainCard[] = [];
  return runWithPolicy({} as never, () => fn(cards), {
    emitCard: (card) => { cards.push(structuredClone(card) as BrainCard); },
  });
}

/** The panel is the ONLY window the user has into a script: a nested call emits no PI tool event. */
describe('CodeModeCardFeed', () => {
  it('opens a row when a nested call starts and closes it when it settles', () => {
    const emitted = withEmitter((cards) => {
      const feed = new CodeModeCardFeed('sess-1');
      const row = feed.callStarted('Read');
      feed.callSettled(row);
      return cards;
    });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.items).toEqual([{ text: 'Read', status: 'in_progress' }]);
    expect(emitted[1]?.items).toEqual([{ text: 'Read', status: 'completed' }]);
    expect(emitted[0]?.id).toBe('code-mode-sess-1');
  });

  it('re-emits under one stable id so the panel updates in place', () => {
    const emitted = withEmitter((cards) => {
      const feed = new CodeModeCardFeed('sess-2');
      feed.callStarted('Read');
      feed.callStarted('Grep');
      return cards;
    });
    expect(new Set(emitted.map((card) => card.id))).toEqual(new Set(['code-mode-sess-2']));
  });

  it('writes a failure into the row text, since a row has no failed status', () => {
    const emitted = withEmitter((cards) => {
      const feed = new CodeModeCardFeed('sess-3');
      const row = feed.callStarted('Bash');
      feed.callSettled(row, 'Bash is not permitted while planning');
      return cards;
    });
    expect(emitted.at(-1)?.items).toEqual([
      { text: 'Bash — Bash is not permitted while planning', status: 'completed' },
    ]);
  });

  it('settles the right row when many calls are open at once and older rows are trimmed', () => {
    const emitted = withEmitter((cards) => {
      const feed = new CodeModeCardFeed('sess-4');
      // Hold one row open, then push past the 20-row cap so the panel trims from the front.
      const first = feed.callStarted('Read');
      const last = feed.callStarted('Grep');
      for (let i = 0; i < 25; i += 1) feed.note(`note ${i}`);
      feed.callSettled(last, 'boom');
      feed.callSettled(first);
      return cards;
    });

    const rows = emitted.at(-1)?.items ?? [];
    // Both original rows have been trimmed away, so settling them must be a no-op rather than a
    // mislabelled note row: an index-based handle would have renamed somebody else's row here.
    expect(rows.every((row) => !row.text.startsWith('Read') && !row.text.startsWith('Grep'))).toBe(true);
    expect(rows.every((row) => !row.text.includes('boom'))).toBe(true);
    expect(rows).toHaveLength(20);
  });

  it('records a notify line as a completed row', () => {
    const emitted = withEmitter((cards) => {
      const feed = new CodeModeCardFeed('sess-5');
      feed.note('halfway');
      return cards;
    });
    expect(emitted.at(-1)?.items).toEqual([{ text: 'halfway', status: 'completed' }]);
  });

  it('clears the panel with an empty card, the registry remove signal', () => {
    const emitted = withEmitter((cards) => {
      const feed = new CodeModeCardFeed('sess-6');
      feed.note('something');
      feed.clear();
      return cards;
    });
    expect(emitted.at(-1)).toEqual({ id: 'code-mode-sess-6' });
  });

  it('drops rows silently outside a turn scope instead of throwing inside a tool call', () => {
    const feed = new CodeModeCardFeed('sess-7');
    expect(() => feed.callSettled(feed.callStarted('Read'))).not.toThrow();
  });
});
