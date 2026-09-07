import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { BrainStore } from '../../../src/store/brainStore.js';
import {
  compareForkPrefix, describeForkPrefixDifference, forkPrefixFirstDifference, forkPrefixReading,
  formatForkPrefixReading, type ForkPrefixSegment,
} from '../../../src/brain/session/forkPrefixDiff.js';

/** The evidence surface a fork verdict of `prefix mismatch` used to lack.
 *
 *  The counters can only say that the child re-billed the conversation; the captured requests can say
 *  which segment it stopped agreeing with, and that is the difference between a number to distrust and a
 *  block to go and look at. Both the fork log line and the post-deploy self-check read this one
 *  comparison, so they can never name two different first differences for the same fork. */

const segment = (section: string, digest: string, extra: Partial<ForkPrefixSegment> = {}): ForkPrefixSegment =>
  ({ section, kind: section === 'input' ? 'input' : section, digest, ...extra });

describe('comparing a fork child’s first request with its parent’s last', () => {
  const parent = [
    segment('system', 'sys-1'),
    segment('tool', 'read'),
    segment('tool', 'bash'),
    segment('input', 'msg-1', { role: 'user' }),
    segment('input', 'msg-2', { role: 'assistant' }),
  ];

  it('is shared when the child opens with all of it and appends its own', () => {
    const child = [...parent, segment('input', 'placeholder', { role: 'user' }), segment('input', 'directive', { role: 'user' })];
    const comparison = compareForkPrefix(parent, child);
    expect(comparison.shared).toBe(true);
    expect(comparison.compared).toBe(5);
    expect(comparison.counts.input).toEqual({ parent: 2, child: 4 });
  });

  it('names the first message that differs, not the last', () => {
    const child = [
      segment('system', 'sys-1'), segment('tool', 'read'), segment('tool', 'bash'),
      segment('input', 'msg-1-without-its-memories', { role: 'user' }),
      segment('input', 'msg-2-different-too', { role: 'assistant' }),
    ];
    const { shared, difference } = compareForkPrefix(parent, child);
    expect(shared).toBe(false);
    expect(difference).toMatchObject({ section: 'input', index: 0, reason: 'changed' });
    expect(describeForkPrefixDifference(difference!)).toBe('input#0 changed (user)');
  });

  // The system prompt and the tool block sit in FRONT of every message, so one changed byte there re-bills
  // the whole conversation — which is why a fork child is composed as its parent was.
  it('reports a system or tool divergence ahead of any message', () => {
    const changedSystem = compareForkPrefix(parent, [segment('system', 'sys-2'), ...parent.slice(1)]);
    expect(describeForkPrefixDifference(changedSystem.difference!)).toBe('system#0 changed (system)');
    const withheldTool = compareForkPrefix(parent, [parent[0]!, parent[1]!, ...parent.slice(3)]);
    expect(describeForkPrefixDifference(withheldTool.difference!)).toBe('tool#1 missing (tool)');
    const extraTool = compareForkPrefix(parent, [...parent.slice(0, 3), segment('tool', 'write'), ...parent.slice(3)]);
    expect(describeForkPrefixDifference(extraTool.difference!)).toBe('tool#2 extra (tool)');
  });

  it('counts both sides even after it has stopped comparing', () => {
    const comparison = compareForkPrefix(parent, [segment('system', 'sys-2')]);
    expect(comparison.counts).toEqual({
      system: { parent: 1, child: 1 }, tool: { parent: 2, child: 0 }, input: { parent: 2, child: 0 },
    });
  });
});

/** …and the same comparison over rows the request recorder actually wrote, because the manifest a request
 *  is stored as is not the payload it was sent as: v2 keeps only a chain root per section and the segments
 *  are content-addressed per session, so the reading has to walk a real chain to produce anything. */
describe('reading the two requests back out of the store', () => {
  const payload = (messages: unknown[], system = 'you are elowen') => ({
    model: 'claude-x', system, max_tokens: 4096,
    tools: [{ name: 'Read', input_schema: { type: 'object' } }, { name: 'Bash', input_schema: { type: 'object' } }],
    messages,
  });
  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
  const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] });

  /** `parentAfterSpawn` is the background-fork shape: the parent takes ANOTHER turn between the moment the
   *  child row was created and the moment the child finally sends its own first request. That request is
   *  the trap — it sits before the child's first one, so anchoring on the child's request picks it. */
  const fixture = (childMessages: unknown[], childSystem?: string, opts: { parentAfterSpawn?: boolean } = {}) => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: 'parent', userId: 1, model: 'claude-x' });
    store.createSession({ id: 'child', userId: 1, model: 'claude-x', parentSessionId: 'parent' });
    const requests = store.providerRequests;
    // Settled straight away: a session may hold only one pending attempt, and a real one is closed by the
    // response that came back before the next request went out.
    const attempt = (sessionId: string, body: unknown, startedAt: number): void => {
      const { requestId } = requests.start({
        sessionId, turnId: `turn-${startedAt}`, kind: 'chat', configuredProvider: 'anthropic',
        wireProvider: 'anthropic', api: 'anthropic-messages', model: 'claude-x', payload: body, startedAt,
      });
      requests.finish({ requestId, status: 'succeeded', finishedAt: startedAt + 500 });
    };
    // The parent's own history: an older request, then the one in flight when the fork was taken.
    attempt('parent', payload([user('<user_memories>…</user_memories>\n\nfirst')]), 1_000);
    attempt('parent', payload([
      user('<user_memories>…</user_memories>\n\nfirst'), assistant('working'),
      user('<user_memories>…</user_memories>\n\nsecond'),
    ]), 2_000);
    // The fork itself: the child row exists from here on. SQLite stores it to the second, exactly as the
    // real column does, so the fixture carries the same truncation the anchor has to survive.
    db.prepare('UPDATE brain_sessions SET created_at = ? WHERE id = ?')
      .run(new Date(2_500).toISOString().replace('T', ' ').slice(0, 19), 'child');
    if (opts.parentAfterSpawn) {
      attempt('parent', payload([
        user('<user_memories>…</user_memories>\n\nfirst'), assistant('working'),
        user('<user_memories>…</user_memories>\n\nsecond'), assistant('delegated'),
        user('<user_memories>a memory the child never carried</user_memories>\n\nthird'),
      ]), 2_800);
    }
    attempt('child', payload(childMessages, childSystem), 3_000);
    // …and a LATER parent request, which describes a conversation the child never saw and must not be the
    // one compared.
    attempt('parent', payload([user('much later')]), 9_000);
    return store;
  };

  const inherited = [
    user('<user_memories>…</user_memories>\n\nfirst'), assistant('working'),
    user('<user_memories>…</user_memories>\n\nsecond'),
  ];

  it('compares the parent request the fork was taken from, not its newest', () => {
    const store = fixture([...inherited, assistant('delegating'), user('Fork started'), user('Your directive: …')]);
    const reading = forkPrefixReading(store.providerRequests, 'parent', 'child')!;
    expect(reading.parent.seq).toBe(2);
    expect(reading.child.seq).toBe(1);
    expect(reading.comparison.shared).toBe(true);
    expect(formatForkPrefixReading(reading, 'parent', 'child')).toContain('verdict=shared');
  });

  // The diagnostic's own failure mode, and the reason a real background fork was reported `not-shared`
  // while the token counters said it had shared: the parent kept working after the fork was taken, so a
  // request of ITS next turn sits between the fork and the child's first request. Anchoring on the fork
  // moment is what keeps that request out of the comparison.
  it('anchors on the moment of the fork, not on the child’s first request', () => {
    const store = fixture(
      [...inherited, assistant('delegating'), user('Fork started'), user('Your directive: …')],
      undefined,
      { parentAfterSpawn: true },
    );
    const reading = forkPrefixReading(store.providerRequests, 'parent', 'child')!;
    expect(reading.parent.seq).toBe(2);
    expect(reading.comparison.shared).toBe(true);
  });

  // No request of the parent's is old enough to be the anchor (capture switched on mid-conversation, a
  // clock that disagrees). Falling back to the old rule keeps a reading rather than reporting nothing.
  it('falls back to the child’s first request when nothing precedes the fork', () => {
    const store = fixture([...inherited, user('Your directive: …')], undefined, { parentAfterSpawn: true });
    const source = {
      // Every request the parent sent BEFORE the fork is gone (capture switched on mid-conversation, a
      // pruned diagnostics table), so the anchor has nothing to select.
      rows: (sessionId: string) => store.providerRequests.rows(sessionId)
        .filter((row) => sessionId !== 'parent' || Number(row.started_at) > 2_400),
      debugRequest: (sessionId: string, requestId: string) => store.providerRequests.debugRequest(sessionId, requestId),
      sessionCreatedAt: (sessionId: string) => store.providerRequests.sessionCreatedAt(sessionId),
    };
    // seq 4 (started at 9_000) is out of reach of both rules; seq 3 — after the fork, before the child's
    // own request — is all the fallback has left, and a reading beats reporting nothing.
    expect(forkPrefixReading(source, 'parent', 'child')?.parent.seq).toBe(3);
  });

  // The M1 failure, end to end: the child rebuilt the parent's messages WITHOUT the ephemeral blocks that
  // went out with them, so its first message is a different segment and everything behind it re-bills.
  it('names the message a seed rebuilt without the frames the parent sent', () => {
    const store = fixture([user('first'), assistant('working'), user('second'), user('Your directive: …')]);
    const reading = forkPrefixReading(store.providerRequests, 'parent', 'child')!;
    expect(reading.comparison.shared).toBe(false);
    expect(describeForkPrefixDifference(reading.comparison.difference!)).toBe('input#0 changed (user)');
    const report = formatForkPrefixReading(reading, 'parent', 'child');
    expect(report).toContain('verdict=not-shared (first difference at input#0 changed (user))');
    expect(report).toContain('parent: input');
  });

  it('names a system prompt the child was composed with differently', () => {
    const store = fixture([...inherited, user('Your directive: …')], 'you are a worker');
    const reading = forkPrefixReading(store.providerRequests, 'parent', 'child')!;
    expect(describeForkPrefixDifference(reading.comparison.difference!)).toBe('system#0 changed (system)');
  });

  it('says nothing at all when either side captured no request', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'parent', userId: 1, model: 'claude-x' });
    store.createSession({ id: 'child', userId: 1, model: 'claude-x' });
    expect(forkPrefixReading(store.providerRequests, 'parent', 'child')).toBeUndefined();
  });
});

/** What the fork log line asks for — the same comparison, gated so a diagnostic can neither answer an
 *  unasked question nor cost the line it decorates. */
describe('the phrase the fork log line adds', () => {
  const sessions = { parentSessionId: 'parent', childSessionId: 'child' };
  const source = {
    rows: (sessionId: string) => [{
      request_id: `${sessionId}-1`, seq: 1, kind: 'chat', status: 'succeeded', started_at: 1_000,
    }],
    debugRequest: (sessionId: string) => ({
      segments: [segment('system', 'sys-1'), segment('input', sessionId === 'parent' ? 'framed' : 'bare', { role: 'user' })],
    }),
  };

  it('names the first difference for a verdict that blames the prefix', () => {
    expect(forkPrefixFirstDifference(source, sessions, { shared: false, reason: 'prefix mismatch' }))
      .toEqual({ firstDifference: 'input#0 changed (user)' });
    expect(forkPrefixFirstDifference(source, sessions, { shared: false, reason: 'prefix rewritten' }))
      .toEqual({ firstDifference: 'input#0 changed (user)' });
  });

  it('stays quiet for a verdict whose cause is already in the reason', () => {
    for (const reason of ['different model', 'provider without cache', 'parent prefix unknown', 'first request failed: x']) {
      expect(forkPrefixFirstDifference(source, sessions, { shared: false, reason })).toEqual({});
    }
    expect(forkPrefixFirstDifference(source, sessions, { shared: true, reason: 'parent prefix reused' })).toEqual({});
  });

  it('never costs the line it decorates', () => {
    const broken = {
      rows: () => { throw new Error('capture table is gone'); },
      debugRequest: () => undefined,
    };
    expect(forkPrefixFirstDifference(broken, sessions, { shared: false, reason: 'prefix mismatch' })).toEqual({});
  });
});
