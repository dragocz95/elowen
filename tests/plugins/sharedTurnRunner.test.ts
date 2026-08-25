import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs plugin module, no types
import { runTurn, DEFAULT_TYPING_INTERVAL_MS } from '../../packages/plugin-shared/turnRunner.mjs';

/** The adapters that consume this engine live in another repository and cannot import it until the
 *  package is published, so these tests ARE its proof. They drive it with fakes that behave like the real
 *  platform verbs — a reaction write that takes time to land, a stream that absorbs its own error — rather
 *  than asserting the shape of the descriptor. */

type Call = [string, ...unknown[]];

function harness(over: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const base = {
    run: async () => 'the answer',
    typing: { poke: record('poke') },
    reactions: {
      seen: 'seen', done: 'done', failed: 'failed',
      add: (v: unknown) => { calls.push(['add', v]); return Promise.resolve(); },
      remove: (v: unknown) => { calls.push(['remove', v]); return Promise.resolve(); },
    },
    ask: { post: record('ask.post'), resolve: record('ask.resolve') },
    send: async (t: unknown) => { calls.push(['send', t]); },
    sendError: async (t: unknown) => { calls.push(['sendError', t]); },
    errorText: (e: { message?: string }) => `sorry: ${e?.message}`,
    log: record('log'),
  };
  return { calls, names: () => calls.map((c) => c[0]), descriptor: { ...base, ...over } };
}

/** A fake live stream that records what the engine asked of it. `failHandled` mirrors the real return of
 *  `LiveMessage.fail()`: true when the progress bubble BECAME the error message. */
function fakeStream(failHandled = false) {
  const events: unknown[] = [];
  const calls: string[] = [];
  return {
    events, calls,
    onEvent: (e: unknown) => { events.push(e); },
    finalize: async (t: unknown) => { calls.push(`finalize:${String(t)}`); },
    fail: async (t: unknown) => { calls.push(`fail:${String(t)}`); return failHandled; },
  };
}

describe('shared turn runner — event routing', () => {
  it('renders and retires a parked question when live streaming is OFF', async () => {
    // The Phase D defect: with no stream the adapters hand-routed events, and a turn blocked inside
    // AskUserQuestion had nothing to draw its choices with — the room parked until the core's timeout.
    const h = harness({
      stream: null,
      run: async (onEvent: (e: unknown) => void) => {
        onEvent({ type: 'ask', id: 'q1', questions: [{ header: 'Where' }] });
        onEvent({ type: 'token', text: 'ignored' });
        onEvent({ type: 'ask_resolved', id: 'q1', reason: 'timeout' });
        return 'the answer';
      },
    });
    await runTurn(h.descriptor);
    expect(h.calls.filter((c) => c[0] === 'ask.post')).toEqual([['ask.post', { type: 'ask', id: 'q1', questions: [{ header: 'Where' }] }]]);
    expect(h.calls.filter((c) => c[0] === 'ask.resolve')).toEqual([['ask.resolve', { type: 'ask_resolved', id: 'q1', reason: 'timeout' }]]);
  });

  it('ignores an ask event with no questions and a resolution with no id', async () => {
    const h = harness({
      stream: null,
      run: async (onEvent: (e: unknown) => void) => {
        onEvent({ type: 'ask', id: 'q1' });
        onEvent({ type: 'ask_resolved', reason: 'timeout' });
        return 'the answer';
      },
    });
    await runTurn(h.descriptor);
    expect(h.names()).not.toContain('ask.post');
    expect(h.names()).not.toContain('ask.resolve');
  });

  it('hands every event to the stream when there is one, and leaves the ask router unused', async () => {
    const stream = fakeStream();
    const h = harness({
      stream,
      run: async (onEvent: (e: unknown) => void) => {
        onEvent({ type: 'ask', id: 'q1', questions: [{ header: 'Where' }] });
        onEvent({ type: 'tool', name: 'Read' });
        return 'the answer';
      },
    });
    await runTurn(h.descriptor);
    expect(stream.events).toHaveLength(2);
    expect(h.names()).not.toContain('ask.post');
  });
});

describe('shared turn runner — completion marker', () => {
  it('gives a STEERED turn no completion marker, but still retires the seen marker', async () => {
    // '' is the steer sentinel: the message was injected into a turn that was already running, so the
    // running turn's own message owns the outcome. A checkmark here claims a completion that has not
    // happened.
    const h = harness({ stream: null, run: async () => '' });
    await runTurn(h.descriptor);
    expect(h.calls).toContainEqual(['remove', 'seen']);
    expect(h.calls).not.toContainEqual(['add', 'done']);
    expect(h.names()).not.toContain('send'); // nothing to deliver either
  });

  it('marks a real answer done and delivers it', async () => {
    const h = harness({ stream: null });
    await runTurn(h.descriptor);
    expect(h.calls).toContainEqual(['send', 'the answer']);
    expect(h.calls).toContainEqual(['add', 'done']);
  });

  it('waits for the seen marker to land before removing it', async () => {
    // A reaction write is a separate REST call. Removing one that has not landed yet leaves the eyes on
    // the message for good — every surface except Teams used to race here.
    const order: string[] = [];
    let landed = () => {};
    const seenLanded = new Promise<void>((r) => { landed = () => { order.push('seen-landed'); r(); }; });
    const h = harness({
      stream: null,
      run: async () => { setTimeout(landed, 5); return 'the answer'; },
      reactions: {
        seen: 'seen', done: 'done', failed: 'failed',
        add: (v: string) => { order.push(`add:${v}`); return v === 'seen' ? seenLanded : Promise.resolve(); },
        remove: (v: string) => { order.push(`remove:${v}`); return Promise.resolve(); },
      },
    });
    await runTurn(h.descriptor);
    // Both halves matter: the turn must not finish before the write lands (an absent 'seen-landed' IS
    // the race), and the removal must come after it.
    expect(order).toContain('seen-landed');
    expect(order.indexOf('seen-landed')).toBeLessThan(order.indexOf('remove:seen'));
  });

  it('adds nothing and removes nothing when the turn must not be decorated', async () => {
    // No triggering message, or a private/targeted invocation where a public reaction would leak that
    // the exchange happened: the adapter passes no reactions at all rather than a suppression flag.
    const h = harness({ stream: null, reactions: null });
    await runTurn(h.descriptor);
    expect(h.names()).not.toContain('add');
    expect(h.names()).not.toContain('remove');
  });

  it('does not remove the seen marker on a surface where a new reaction replaces it', async () => {
    // Telegram and WhatsApp supersede the previous reaction; an explicit delete would be a wrong extra
    // call, so they omit `remove` instead of the engine branching on a platform name.
    const h = harness({
      stream: null,
      reactions: { seen: 'seen', done: 'done', failed: 'failed', add: (v: unknown) => { h.calls.push(['add', v]); return Promise.resolve(); } },
    });
    await runTurn(h.descriptor);
    expect(h.calls).toContainEqual(['add', 'done']);
    expect(h.names()).not.toContain('remove');
  });

  it('still marks the turn done when a post-delivery extra fails', async () => {
    const h = harness({ stream: null, afterReply: async () => { throw new Error('tts down'); } });
    await runTurn(h.descriptor);
    expect(h.calls).toContainEqual(['add', 'done']);
    expect(h.names()).toContain('log');
  });
});

describe('shared turn runner — failure', () => {
  it('logs the failure, tells the stream, marks it failed and replies once', async () => {
    const stream = fakeStream(false);
    const h = harness({ stream, run: async () => { throw new Error('model exploded'); } });
    const reply = await runTurn(h.descriptor);
    expect(reply).toBeUndefined();
    // The catch is what keeps the gateway promise from rejecting, so an unlogged failure means an
    // operator reads a healthy daemon log while every turn dies in the chat.
    expect(h.calls.find((c) => c[0] === 'log')?.[1]).toContain('model exploded');
    expect(stream.calls).toContain('fail:sorry: model exploded');
    expect(h.calls).toContainEqual(['add', 'failed']);
    expect(h.calls).toContainEqual(['sendError', 'sorry: model exploded']);
  });

  it('sends no duplicate error when the stream absorbed it', async () => {
    const stream = fakeStream(true);
    const h = harness({ stream, run: async () => { throw new Error('nope'); } });
    await runTurn(h.descriptor);
    expect(h.names()).not.toContain('sendError');
  });
});

describe('shared turn runner — typing', () => {
  it('pokes immediately, keeps poking on the surface interval, and stops when the turn ends', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ stream: null, typing: { poke: () => { h.calls.push(['poke']); }, stop: () => { h.calls.push(['stop']); }, intervalMs: 1000 } });
      let finish = (_: string) => {};
      const running = new Promise<string>((r) => { finish = r; });
      const turn = runTurn({ ...h.descriptor, run: () => running });
      expect(h.names().filter((n) => n === 'poke')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.names().filter((n) => n === 'poke')).toHaveLength(4);
      finish('the answer');
      await turn;
      await vi.advanceTimersByTimeAsync(10_000);
      // Cleared in `finally`: the copies cleared it once per branch, so the next early return leaked a
      // timer poking a conversation that had already been answered.
      expect(h.names().filter((n) => n === 'poke')).toHaveLength(4);
      expect(h.names()).toContain('stop');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the typing interval when the turn throws', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ stream: null, typing: { poke: () => { h.calls.push(['poke']); }, intervalMs: 1000 }, run: async () => { throw new Error('boom'); } });
      await runTurn(h.descriptor);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.names().filter((n) => n === 'poke')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shared turn runner — descriptor contract', () => {
  it('names the missing verb instead of dying halfway through a live turn', async () => {
    const h = harness({ stream: null });
    await expect(runTurn({ ...h.descriptor, sendError: undefined })).rejects.toThrow('runTurn: sendError must be a function');
    expect(h.names()).not.toContain('poke'); // nothing started, so nothing to unwind
  });

  it('the streaming-OFF router covers exactly the events the stream routes back to the adapter', () => {
    // Derived, not a hand-kept list. The live reducer hands two event kinds back to the ADAPTER
    // (postAsk/resolveAsk); those same kinds are precisely what the no-stream path has to forward itself.
    // A third one added to the reducer tomorrow fails here until this router forwards it too — which is
    // exactly how the ask-with-streaming-off gap opened in the first place.
    const pkgDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'packages', 'plugin-shared');
    const liveSrc = readFileSync(join(pkgDir, 'liveMessage.mjs'), 'utf-8');
    const runnerSrc = readFileSync(join(pkgDir, 'turnRunner.mjs'), 'utf-8');
    const kindMatches = (src: string) => [...src.matchAll(/e\.type === '([a-z_]+)'/g)];

    const adapterFacing = new Set<string>();
    const branches = kindMatches(liveSrc);
    branches.forEach((match, i) => {
      const body = liveSrc.slice(match.index!, branches[i + 1]?.index ?? liveSrc.length);
      if (/this\.a\.(postAsk|resolveAsk)/.test(body)) adapterFacing.add(match[1]!);
    });
    expect(adapterFacing.size, 'the reducer still hands work back to the adapter').toBeGreaterThan(0);

    const routed = new Set(kindMatches(runnerSrc).map((m) => m[1]!));
    expect([...routed].sort()).toEqual([...adapterFacing].sort());
  });

  it('publishes the default typing interval the surfaces fall back to', () => {
    expect(DEFAULT_TYPING_INTERVAL_MS).toBe(8000);
  });
});
