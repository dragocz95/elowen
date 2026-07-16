import { describe, it, expect } from 'vitest';
import { recordSessionEvent, drainSessionNotices } from '../../src/brain/service/sessionEvents.js';
import type { BrainStore, BrainSessionEvent, SessionEventKind } from '../../src/store/brainStore.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';
import type { BrainEvent } from '../../src/brain/events.js';

function fakeLive(published: BrainEvent[]): LiveBrain {
  return {
    sessionId: 's1',
    replay: { publish: (event: BrainEvent) => { published.push(event); } },
  } as unknown as LiveBrain;
}

/** `hasTurns: false` models a conversation nobody has spoken in yet (lastMessageAt returns undefined). */
function fakeStore(hasTurns = true): BrainStore & { appended: { kind: string; detail: string }[] } {
  let seq = 0;
  const appended: { kind: string; detail: string }[] = [];
  return {
    appended,
    lastMessageAt: () => (hasTurns ? '2026-07-16 09:00:00' : undefined),
    appendSessionEvent(_sessionId: string, kind: SessionEventKind, detail: string): BrainSessionEvent {
      seq += 1;
      appended.push({ kind, detail });
      return { id: `evt-${seq}`, kind, detail, at: `2026-07-16T09:0${seq}:00.000Z` };
    },
  } as unknown as BrainStore & { appended: { kind: string; detail: string }[] };
}

describe('recordSessionEvent', () => {
  it('persists the marker, publishes it live, and queues a one-shot model-facing notice', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    recordSessionEvent(fakeStore(), 's1', live, 'model', '  anthropic/claude  ');

    expect(published).toEqual([{ type: 'session-event', id: 'evt-1', kind: 'model', detail: 'anthropic/claude', at: '2026-07-16T09:01:00.000Z' }]);
    expect(live.pendingSessionNotices).toEqual(['switched your model to anthropic/claude']);
  });

  it('ignores a blank detail (nothing persisted, published or queued)', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    const store = fakeStore();
    recordSessionEvent(store, 's1', live, 'rename', '   ');
    expect(store.appended).toEqual([]);
    expect(published).toEqual([]);
    expect(live.pendingSessionNotices).toBeUndefined();
  });

  // Setting up a conversation before speaking in it is not a change to anything: the first prompt already
  // carries the chosen model/mode, so a marker above it would report history that never happened.
  it('records nothing in a conversation that has no turns yet', () => {
    const published: BrainEvent[] = [];
    const live = fakeLive(published);
    const store = fakeStore(false);
    recordSessionEvent(store, 's1', live, 'model', 'anthropic/claude');
    expect(store.appended).toEqual([]);
    expect(published).toEqual([]);
    expect(live.pendingSessionNotices).toBeUndefined();
  });

  // Renaming from the picker: the marker must still be durable, but there is no stream and no agent to tell.
  it('persists the marker only when the conversation is not live', () => {
    const store = fakeStore();
    recordSessionEvent(store, 's1', undefined, 'rename', 'Marker demo');
    expect(store.appended).toEqual([{ kind: 'rename', detail: 'Marker demo' }]);
  });
});

describe('drainSessionNotices', () => {
  it('emits one <system-reminder> for the queued notices, then clears the buffer (one-shot)', () => {
    const live = { pendingSessionNotices: ['switched the work mode to Workflow', 'set your reasoning effort to high'] } as unknown as LiveBrain;
    const reminder = drainSessionNotices(live);

    expect(reminder).toContain('<session-changes>');
    expect(reminder).toContain('- The user switched the work mode to Workflow.');
    expect(reminder).toContain('- The user set your reasoning effort to high.');
    expect(reminder).toContain('<instruction>');
    expect(live.pendingSessionNotices).toEqual([]);
    expect(drainSessionNotices(live)).toBe('');
  });

  it('returns an empty string when nothing is queued', () => {
    expect(drainSessionNotices({} as unknown as LiveBrain)).toBe('');
  });
});
