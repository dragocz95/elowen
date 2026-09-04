import { describe, it, expect, vi } from 'vitest';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import type { AskQuestion, BrainEvent } from '../../src/brain/events.js';

const Q: AskQuestion[] = [{ question: 'Pick one', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];

describe('ElicitationRegistry — parked AskUserQuestion lifecycle', () => {
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

  it("an approval ask carries kind:'approval' on the event and the reconnect snapshot", async () => {
    const reg = new ElicitationRegistry();
    let emitted: BrainEvent | null = null;
    const p = reg.ask('sess-1', Q, (e) => { emitted = e; }, 'approval');
    expect(emitted).toMatchObject({ type: 'ask', kind: 'approval' });
    expect(reg.pendingForSession('sess-1')).toMatchObject({ kind: 'approval' });
    reg.answer((emitted as unknown as { id: string }).id, [{ header: 'Choice', selected: ['A'] }]);
    await p;
    // A regular question stays kind-less (older clients never see an unexpected field).
    let plain: BrainEvent | null = null;
    const p2 = reg.ask('sess-1', Q, (e) => { plain = e; });
    expect(Object.keys(plain as unknown as object)).not.toContain('kind');
    expect(reg.pendingForSession('sess-1')).not.toHaveProperty('kind');
    reg.answer((plain as unknown as { id: string }).id, [{ header: 'Choice', selected: ['A'] }]);
    await p2;
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

  it.each([
    ['wrong answer count', [], Q],
    ['unknown selected label', [{ header: 'Choice', selected: ['C'] }], Q],
    ['more than one pick for single-select', [{ header: 'Choice', selected: ['A', 'B'] }], Q],
    ['custom text when custom input is disabled', [{ header: 'Choice', selected: ['A'], other: 'note' }], [{ ...Q[0]!, custom: false }]],
    ['a mismatched header', [{ header: 'Other', selected: ['A'] }], Q],
  ])('rejects %s without consuming the pending prompt', async (_name, answers, questions) => {
    const reg = new ElicitationRegistry();
    let id = '';
    const pending = reg.ask('sess-1', questions as AskQuestion[], (e) => { if (e.type === 'ask') id = e.id; });
    expect(reg.answer(id, answers as never)).toBe(false);
    expect(reg.pendingForSession('sess-1')?.id).toBe(id);
    expect(reg.answer(id, [{ header: 'Choice', selected: ['A'] }])).toBe(true);
    await expect(pending).resolves.toEqual([{ header: 'Choice', selected: ['A'] }]);
  });

  it('accepts multiple distinct known labels only when the pending question is multi-select', async () => {
    const reg = new ElicitationRegistry();
    let id = '';
    const questions: AskQuestion[] = [{ ...Q[0]!, multiSelect: true, custom: true }];
    const pending = reg.ask('sess-1', questions, (e) => { if (e.type === 'ask') id = e.id; });
    const answers = [{ header: 'Choice', selected: ['A', 'B'], other: 'note' }];
    expect(reg.answer(id, answers)).toBe(true);
    await expect(pending).resolves.toEqual(answers);
  });

  it('rejects duplicate multi-select labels and preserves the prompt for a corrected answer', async () => {
    const reg = new ElicitationRegistry();
    let id = '';
    const questions: AskQuestion[] = [{ ...Q[0]!, multiSelect: true }];
    const pending = reg.ask('sess-1', questions, (e) => { if (e.type === 'ask') id = e.id; });
    expect(reg.answer(id, [{ header: 'Choice', selected: ['A', 'A'] }])).toBe(false);
    expect(reg.pendingForSession('sess-1')?.id).toBe(id);
    reg.answer(id, [{ header: 'Choice', selected: ['B'] }]);
    await pending;
  });

  it('serializes two back-to-back approvals in one session — neither cancels the other into a deny', async () => {
    const reg = new ElicitationRegistry();
    const events: { id: string }[] = [];
    // Only the parks — settling one now emits an `ask_resolved` on the same fan-out, and this test
    // counts how many questions were RAISED.
    const emit = (e: BrainEvent) => { if (e.type === 'ask') events.push(e as unknown as { id: string }); };
    const p1 = reg.ask('sess-1', Q, emit, 'approval');
    const p2 = reg.ask('sess-1', Q, emit, 'approval');
    // Only the FIRST approval is parked/emitted; the second queues behind it (no supersede-cancel).
    expect(events).toHaveLength(1);
    expect(reg.pendingForSession('sess-1')?.id).toBe(events[0]!.id);
    // Answering the first resolves it with the real pick (NOT a spurious deny from a sibling cancel).
    expect(reg.answer(events[0]!.id, [{ header: 'Choice', selected: ['A'] }])).toBe(true);
    await expect(p1).resolves.toEqual([{ header: 'Choice', selected: ['A'] }]);
    // The queued approval now parks/emits and can be answered on its own.
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(events).toHaveLength(2);
    expect(reg.answer(events[1]!.id, [{ header: 'Choice', selected: ['B'] }])).toBe(true);
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

  // The `ask` event fans out to EVERY client of the conversation, so one surface answering leaves the
  // others showing a prompt that can no longer be settled. Each exit has to say so on the same fan-out.
  it('announces the answer so the surfaces that did not answer can drop the prompt', async () => {
    const reg = new ElicitationRegistry();
    const events: BrainEvent[] = [];
    const p = reg.ask('sess-1', Q, (e) => { events.push(e); });
    const id = (events[0] as { id: string }).id;
    reg.answer(id, [{ header: 'Choice', selected: ['A'] }]);
    await p;
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: 'ask_resolved', id, reason: 'answered' });
    // Emitted after the entry is gone, so a /brain/status racing the event agrees with it.
    expect(reg.pendingForSession('sess-1')).toBeNull();
  });

  it('announces a timeout, so an unanswered prompt does not linger on every surface', async () => {
    vi.useFakeTimers();
    try {
      const reg = new ElicitationRegistry(1000);
      const events: BrainEvent[] = [];
      const p = reg.ask('sess-1', Q, (e) => { events.push(e); });
      const id = (events[0] as { id: string }).id;
      vi.advanceTimersByTime(1001);
      await p;
      expect(events[1]).toEqual({ type: 'ask_resolved', id, reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces a cancel — abort and supersede both leave a dock up otherwise', async () => {
    const reg = new ElicitationRegistry();
    const events: BrainEvent[] = [];
    const p = reg.ask('sess-1', Q, (e) => { events.push(e); });
    const id = (events[0] as { id: string }).id;
    reg.cancelForSession('sess-1', 'aborted');
    await expect(p).rejects.toThrow('aborted');
    expect(events[1]).toEqual({ type: 'ask_resolved', id, reason: 'cancelled' });

    // cancelAll (plugin reload / dispose-all) has the same obligation.
    const events2: BrainEvent[] = [];
    const p2 = reg.ask('sess-2', Q, (e) => { events2.push(e); });
    const id2 = (events2[0] as { id: string }).id;
    reg.cancelAll('sessions reset');
    await expect(p2).rejects.toThrow('sessions reset');
    expect(events2[1]).toEqual({ type: 'ask_resolved', id: id2, reason: 'cancelled' });
  });

  it('a superseding question resolves the one it replaces, not just the promise', async () => {
    const reg = new ElicitationRegistry();
    const events: BrainEvent[] = [];
    const p1 = reg.ask('sess-1', Q, (e) => { events.push(e); });
    const first = (events[0] as { id: string }).id;
    // A second regular question drops the earlier one — which must be announced, or the first question's
    // dock stays on screen underneath the second.
    const p2 = reg.ask('sess-1', Q, (e) => { events.push(e); });
    await expect(p1).rejects.toThrow(/superseded/);
    expect(events[1]).toEqual({ type: 'ask_resolved', id: first, reason: 'cancelled' });
    expect(events[2]).toMatchObject({ type: 'ask' });
    reg.answer((events[2] as { id: string }).id, [{ header: 'Choice', selected: ['B'] }]);
    await expect(p2).resolves.toEqual([{ header: 'Choice', selected: ['B'] }]);
  });
});
