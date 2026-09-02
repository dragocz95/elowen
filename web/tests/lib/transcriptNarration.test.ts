import { describe, expect, it } from 'vitest';
import { emptyView, fromHistory, liveNarration, NARRATION_MAX_CHARS, reduce } from '../../lib/transcript';

/** The projection a plugin artifact gets when its own surface covers the transcript (API 14's
 *  `narration`). What it must NOT carry is the point of most of these: an artifact that draws over the
 *  dock is still a chat surface, and it may only ever show what the dock itself is showing. */
describe('liveNarration: the assistant prose a covering surface may show', () => {
  it('follows the streaming reply and clears when the user speaks again', () => {
    let view = reduce(emptyView(), { type: 'text', delta: 'Opening the portal' });
    expect(liveNarration(view.turns)).toBe('Opening the portal');

    view = reduce(view, { type: 'text', delta: ' and signing in.' });
    expect(liveNarration(view.turns)).toBe('Opening the portal and signing in.');

    // A new question is the conversation moving on: the previous answer must not linger over the canvas.
    view = reduce(view, { type: 'user', text: 'stop there' });
    expect(liveNarration(view.turns)).toBe('');
  });

  it('carries only visible prose — never reasoning, tool rows or their output', () => {
    let view = reduce(emptyView(), { type: 'reasoning', delta: 'the user probably wants the cheapest slot' });
    expect(liveNarration(view.turns)).toBe('');

    view = reduce(view, { type: 'tool', name: 'BrowserOpen', detail: 'https://portal.example.com', id: 'call-1' });
    view = reduce(view, { type: 'tool_output', id: 'call-1', output: { kind: 'result', title: 'BrowserOpen', text: 'opened' } });
    expect(liveNarration(view.turns)).toBe('');

    view = reduce(view, { type: 'text', delta: 'The booking form is open.' });
    expect(liveNarration(view.turns)).toBe('The booking form is open.');
  });

  it('speaks the newest sentence, not the whole turn', () => {
    let view = reduce(emptyView(), { type: 'text', delta: 'Looking for a slot.' });
    view = reduce(view, { type: 'tool', name: 'BrowserClick', detail: 'Continue', id: 'call-2' });
    view = reduce(view, { type: 'text', delta: 'Thursday at 09:00 is free.' });
    expect(liveNarration(view.turns)).toBe('Thursday at 09:00 is free.');
  });

  it('collapses whitespace and keeps the live tail of a long reply', () => {
    const long = `${'word '.repeat(200)}the last thing said`;
    const view = reduce(emptyView(), { type: 'text', delta: `  multi\n\nline   text  ` });
    expect(liveNarration(view.turns)).toBe('multi line text');

    const capped = liveNarration(reduce(emptyView(), { type: 'text', delta: long }).turns);
    expect(capped.length).toBeLessThanOrEqual(NARRATION_MAX_CHARS);
    expect(capped.endsWith('the last thing said')).toBe(true);
    expect(capped.startsWith('word')).toBe(true); // cut at a word boundary, never mid-word
  });

  it('reads the same text a reloaded transcript renders, and nothing from an older turn', () => {
    const view = fromHistory([
      { role: 'user', text: 'book it', id: 'm1' },
      { role: 'assistant', text: 'Booked for Thursday.', id: 'm2' },
      { role: 'user', text: 'and Friday?', id: 'm3' },
    ]);
    // The newest turn is the user's: a canvas opened now shows no narration at all rather than the
    // answer to the previous question.
    expect(liveNarration(view.turns)).toBe('');
    expect(liveNarration(view.turns.slice(0, 2))).toBe('Booked for Thursday.');
    // Nothing survives a session switch, because the switch replaces the turns themselves.
    expect(liveNarration(emptyView().turns)).toBe('');
  });
});
