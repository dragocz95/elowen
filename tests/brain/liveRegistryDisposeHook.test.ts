/**
 * A live session can own resources the PI session does not: today a code-mode cell, which is a worker
 * THREAD that deliberately outlives its turn. The release is attached to `dispose()` rather than to the
 * call sites because there are many of them — clear, model switch, respawn, channel reset, conversation
 * delete — and a release attached to one of them is a leak on every other.
 */
import { describe, it, expect } from 'vitest';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';

type Rec = { sessionId: string; session: { dispose(): void; isStreaming: boolean } };

function record(id: string): Rec {
  return { sessionId: id, session: { dispose: () => {}, isStreaming: false } };
}

describe('LiveSessionRegistry — external resource disposer', () => {
  it('fires once per disposed session, after the record is gone', () => {
    const disposed: string[] = [];
    const seenWhileDisposing: boolean[] = [];
    const r = new LiveSessionRegistry<Rec>((id) => {
      disposed.push(id);
      seenWhileDisposing.push(r.has(id));
    });

    r.set('a', record('a'));
    r.set('b', record('b'));
    r.dispose('a');

    expect(disposed).toEqual(['a']);
    // The hook must not be able to observe a half-removed session.
    expect(seenWhileDisposing).toEqual([false]);
    expect(r.has('b')).toBe(true);
  });

  it('does not fire for a session that was never live', () => {
    const disposed: string[] = [];
    const r = new LiveSessionRegistry<Rec>((id) => disposed.push(id));

    r.dispose('ghost');
    r.set('a', record('a'));
    r.dispose('a');
    r.dispose('a'); // second teardown of the same id — already forgotten

    expect(disposed).toEqual(['a']);
  });

  it('stays optional, so a registry without external resources needs no hook', () => {
    const r = new LiveSessionRegistry<Rec>();
    r.set('a', record('a'));
    expect(() => r.dispose('a')).not.toThrow();
    expect(r.has('a')).toBe(false);
  });
});
