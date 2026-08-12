import { describe, it, expect } from 'vitest';
import { buildTurnDone, notificationPreview } from '../../src/push/messages.js';

// A phone renders no markdown, so anything left in arrives as literal punctuation the reader has to look
// past. The preview has to be the sentence the answer opens with, on one line.
describe('turn-done preview', () => {
  it('shows the answer, titled by the conversation it came from', () => {
    const p = buildTurnDone({ title: 'Elowen', preview: 'Hotovo, nasadil jsem to.' });
    expect(p.title).toBe('Elowen');
    expect(p.body).toBe('Hotovo, nasadil jsem to.');
    expect(p.url).toBe('/chat');
  });

  it('falls back to a fixed banner when the answer is empty', () => {
    expect(buildTurnDone({ title: 'Elowen', preview: '' }).body).toBe('Vaše konverzace je hotová.');
    expect(buildTurnDone({ title: '', preview: 'x' }).title).toBe('Elowen dokončil práci');
  });

  it('drops a code block instead of showing two lines of a diff', () => {
    expect(notificationPreview('Opravil jsem to:\n\n```ts\nconst x = 1;\n```\n\nBrány jsou zelené.'))
      .toBe('Opravil jsem to: Brány jsou zelené.');
  });

  it('drops the tail of an answer cut off inside a code block', () => {
    expect(notificationPreview('Hotovo:\n```diff\n+ a\n- b')).toBe('Hotovo:');
  });

  it('strips markdown syntax rather than reading it aloud', () => {
    expect(notificationPreview('**Hotovo** — `npm test` prošel, viz [commit](http://x/y).'))
      .toBe('Hotovo — npm test prošel, viz commit.');
    expect(notificationPreview('## Nadpis\n- první\n- druhý')).toBe('Nadpis • první • druhý');
  });

  it('collapses newlines so the notification stays one readable line', () => {
    expect(notificationPreview('První věta.\n\nDruhá věta.')).toBe('První věta. Druhá věta.');
  });

  it('truncates a long answer with an ellipsis', () => {
    const body = buildTurnDone({ title: 'x', preview: 'a'.repeat(400) }).body;
    expect(body).toHaveLength(180);
    expect(body.endsWith('…')).toBe(true);
  });

  // The cut is by code point: slicing mid-surrogate would end the body in half an emoji, which a phone
  // draws as the replacement glyph.
  it('never cuts an emoji in half', () => {
    const body = buildTurnDone({ title: 'x', preview: `${'a'.repeat(178)}😀🎉` }).body;
    // A lone high surrogate anywhere means the cut landed inside an emoji; the trailing ellipsis would
    // hide it from a plain end-of-string check.
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect([...body].length).toBe(180);
  });

  // This runs synchronously on the daemon's event loop for every notified turn, over text the model may
  // have quoted from anywhere. An unclosed `](` used to make the link regex rescan the rest of the text at
  // every occurrence — 80 kB of it froze the loop for nearly two seconds.
  it('shrugs off input built to make the scanner backtrack', () => {
    const started = Date.now();
    notificationPreview('[a]('.repeat(20_000));
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('still unwraps a normal link after the URL was bounded', () => {
    expect(notificationPreview('viz [commit](https://github.com/dragocz95/elowen/commit/abc123)')).toBe('viz commit');
  });

  // Second line of defence behind the bounded URL: the scanner never reads more of an answer than the
  // preview could ever show, so no future pattern added here can be fed an unbounded string.
  it('reads only the opening of a very long answer', () => {
    expect(notificationPreview(`${'a'.repeat(5_000)} KONEC`)).not.toContain('KONEC');
  });
});
