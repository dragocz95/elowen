import { describe, it, expect, vi } from 'vitest';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import type { AskQuestion, BrainEvent } from '../../src/brain/events.js';

const Q: AskQuestion[] = [{ question: 'Pick one', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];

describe('ElicitationRegistry — parked ask_user_question lifecycle', () => {
  it('emits an ask event, then resolves the parked promise with the answer', async () => {
    const reg = new ElicitationRegistry();
    let emitted: BrainEvent | null = null;
    const p = reg.ask('sess-1', Q, (e) => { emitted = e; });
    expect(emitted).not.toBeNull();
    expect(emitted!.type).toBe('ask');
    const id = (emitted as { id: string }).id;
    const answers = [{ header: 'Choice', selected: ['A'] }];
    expect(reg.answer(id, answers)).toBe(true);
    await expect(p).resolves.toEqual(answers);
  });

  it('answer() on an unknown/expired id is a tolerated no-op', () => {
    const reg = new ElicitationRegistry();
    expect(reg.answer('nope', [])).toBe(false);
  });

  it('a second answer for the same id no-ops (double-click tolerance)', async () => {
    const reg = new ElicitationRegistry();
    let id = '';
    const p = reg.ask('sess-1', Q, (e) => { id = (e as { id: string }).id; });
    expect(reg.answer(id, [{ header: 'Choice', selected: ['A'] }])).toBe(true);
    expect(reg.answer(id, [{ header: 'Choice', selected: ['B'] }])).toBe(false);
    await expect(p).resolves.toEqual([{ header: 'Choice', selected: ['A'] }]);
  });

  it('cancelForSession rejects only the matching session and leaves others parked', async () => {
    const reg = new ElicitationRegistry();
    let idOther = '';
    const p1 = reg.ask('sess-1', Q, () => {});
    const p2 = reg.ask('sess-2', Q, (e) => { idOther = (e as { id: string }).id; });
    reg.cancelForSession('sess-1', 'aborted');
    await expect(p1).rejects.toThrow('aborted');
    // sess-2 is untouched — it still resolves normally.
    expect(reg.answer(idOther, [{ header: 'Choice', selected: ['B'] }])).toBe(true);
    await expect(p2).resolves.toEqual([{ header: 'Choice', selected: ['B'] }]);
  });

  it('times out to a per-question no-answer sentinel when nobody answers', async () => {
    vi.useFakeTimers();
    try {
      const reg = new ElicitationRegistry(1000);
      const p = reg.ask('sess-1', Q, () => {});
      vi.advanceTimersByTime(1001);
      const res = await p;
      expect(res).toHaveLength(1);
      expect(res[0].header).toBe('Choice');
      expect(res[0].selected[0]).toMatch(/no answer/);
    } finally {
      vi.useRealTimers();
    }
  });
});
