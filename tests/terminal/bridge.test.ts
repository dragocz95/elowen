import { describe, it, expect } from 'vitest';
import { bridge } from '../../src/terminal/bridge.js';
import type { PtySession } from '../../src/terminal/ptySession.js';

function fakePty() {
  const calls = { write: [] as string[], resize: [] as number[][], killed: false, emit: null as null | ((d: string) => void) };
  const pty: PtySession = {
    onData: (cb) => { calls.emit = cb; },
    write: (d) => { calls.write.push(d); },
    resize: (c, r) => { calls.resize.push([c, r]); },
    kill: () => { calls.killed = true; },
  };
  return { pty, calls };
}

describe('bridge', () => {
  it('pipes pty output to ws.send', () => {
    const { pty, calls } = fakePty();
    const sent: string[] = [];
    bridge(pty, { send: (d) => sent.push(d), close: () => {} });
    calls.emit!('hello');
    expect(sent).toEqual(['hello']);
  });

  it('routes a resize control frame to pty.resize', () => {
    const { pty, calls } = fakePty();
    const b = bridge(pty, { send: () => {}, close: () => {} });
    b.onMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    expect(calls.resize).toEqual([[120, 40]]);
    expect(calls.write).toEqual([]);
  });

  it('also notifies onResize on a resize control frame', () => {
    const { pty, calls } = fakePty();
    const seen: number[][] = [];
    const b = bridge(pty, { send: () => {}, close: () => {} }, (c, r) => seen.push([c, r]));
    b.onMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    expect(calls.resize).toEqual([[120, 40]]); // the PTY is still resized
    expect(seen).toEqual([[120, 40]]);          // and the tmux window too
  });

  it('treats non-control messages as raw input bytes', () => {
    const { pty, calls } = fakePty();
    const b = bridge(pty, { send: () => {}, close: () => {} });
    b.onMessage('ls\n');
    b.onMessage('{not json');
    expect(calls.write).toEqual(['ls\n', '{not json']);
  });

  it('dispose kills the pty', () => {
    const { pty, calls } = fakePty();
    const b = bridge(pty, { send: () => {}, close: () => {} });
    b.dispose();
    expect(calls.killed).toBe(true);
  });
});
