import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEAR_MIN_BYTES,
  SPILL_MAX_RESULT_BYTES,
  SPILL_PREVIEW_CHARS,
  applyToolResultClearing,
  cacheColdAtTurnStart,
  cacheTtlMs,
  clearedToolResultDetails,
  clearedToolResultPlaceholder,
  clearingCutIndex,
  idleThresholdMs,
  isClearedToolResult,
  spillPreview,
  installToolResultClearing,
  selectClearableToolResults,
  toolResultSpillPath,
  toolResultOccurrenceKey,
  parseSpillDescriptor,
  persistToolOutputSpill,
} from '../../../src/brain/session/toolResultClearing.js';
import type { PersistedToolResultLatch, ToolResultLatchStore } from '../../../src/brain/session/toolResultClearing.js';
import { openDb } from '../../../src/store/db.js';
import { BrainStore } from '../../../src/store/brainStore.js';
import { HISTORY_IMAGE_PLACEHOLDER } from '../../../src/brain/session/historyImageStripping.js';
import type { PiAgentMessage } from '../../../src/brain/session/historyImageStripping.js';

let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const T0 = 1_000_000;
const IDLE = 60_000;

const user = (text: string, timestamp: number): PiAgentMessage =>
  ({ role: 'user', content: [{ type: 'text', text }], timestamp });

const assistant = (text: string, timestamp: number): PiAgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'test-model',
  usage: {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop', timestamp,
});

const toolResult = (toolCallId: string, text: string, timestamp: number): PiAgentMessage => ({
  role: 'toolResult', toolCallId, toolName: 'Bash',
  content: [{ type: 'text', text }], isError: false, timestamp,
});

const big = 'x'.repeat(CLEAR_MIN_BYTES + 100);
const small = 'y'.repeat(100);
/** Over the size trigger by one byte — every character is 1 byte, so length is the byte count. */
const oversized = `HEAD-${'z'.repeat(SPILL_MAX_RESULT_BYTES - 3)}-TAIL`;

interface Harness {
  session: { agent: { transformContext?: (m: PiAgentMessage[], s?: AbortSignal) => Promise<PiAgentMessage[]> } };
  transform: (m: PiAgentMessage[]) => Promise<PiAgentMessage[]>;
  writes: Map<string, string>;
}

function harness(options: {
  idleMs?: number;
  writeSpill?: (p: string, t: string) => Promise<void>;
  readSpill?: (p: string) => Promise<string | null>;
} = {}): Harness {
  const writes = new Map<string, string>();
  const session: Harness['session'] = { agent: {} };
  installToolResultClearing(session, 'sess-1', {
    idleMs: options.idleMs ?? IDLE,
    spillDir: '/tmp/spill/sess-1',
    writeSpill: options.writeSpill ?? (async (p, t) => { writes.set(p, t); }),
    readSpill: options.readSpill ?? (async () => null),
  });
  return { session, writes, transform: (m) => session.agent.transformContext!(m) };
}

/** The spill path actually written for a toolCallId. Located by its stable `<id>.v1-` prefix rather than
 *  rebuilt, so a test does not have to restate the byte count the module encodes into the name. */
function spillPath(h: Harness, toolCallId: string): string {
  const prefix = `/tmp/spill/sess-1/${toolCallId}.v1-`;
  const found = [...h.writes.keys()].find((p) => p.startsWith(prefix));
  if (!found) throw new Error(`no spill written for ${toolCallId}`);
  return found;
}

describe('selectClearableToolResults / clearingCutIndex', () => {
  it('keeps the current and previous user turns, selects only large older results with an id', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0),
      toolResult('old-big', big, T0 + 1),
      toolResult('old-small', small, T0 + 2),
      { role: 'toolResult', toolCallId: '', toolName: 'Bash', content: [{ type: 'text', text: big }], isError: false, timestamp: T0 + 3 } as PiAgentMessage,
      assistant('done', T0 + 4),
      user('two', T0 + 5),
      toolResult('prev-turn-big', big, T0 + 6),
      assistant('done', T0 + 7),
      user('three', T0 + 8),
      toolResult('current-big', big, T0 + 9),
    ];
    const cut = clearingCutIndex(messages);
    expect(messages[cut]).toBe(messages[5]); // the 'two' user message starts the previous turn
    const selected = selectClearableToolResults(messages, new Set());
    expect(selected.map((s) => s.toolCallId)).toEqual(['old-big']);
    expect(selected[0]?.bytes).toBe(big.length);
  });

  it('selects nothing when the conversation has fewer than two user messages', () => {
    const messages: PiAgentMessage[] = [user('one', T0), toolResult('big-1', big, T0 + 1)];
    expect(clearingCutIndex(messages)).toBe(-1);
    expect(selectClearableToolResults(messages, new Set())).toEqual([]);
  });

  it('does not count a recalled-memory meta message toward retained user turns', () => {
    const recalled = { ...user('recalled memory', T0 + 4), isMeta: true };
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1),
      user('two', T0 + 2), toolResult('current-big', big, T0 + 3), recalled,
    ];

    expect(clearingCutIndex(messages)).toBe(0);
    expect(selectClearableToolResults(messages, new Set())).toEqual([]);
  });

  it('skips already-latched occurrences, but never a fresh result that merely reuses the id', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1), user('two', T0 + 2), user('three', T0 + 3),
    ];
    expect(selectClearableToolResults(messages, new Set([toolResultOccurrenceKey('old-big', T0 + 1)]))).toEqual([]);
    // The latch of a DIFFERENT occurrence of the same id (another timestamp) masks nothing here:
    // sequential id styles reuse ids, and the reused result must be judged on its own.
    expect(
      selectClearableToolResults(messages, new Set([toolResultOccurrenceKey('old-big', T0 + 999)]))
        .map((s) => s.toolCallId),
    ).toEqual(['old-big']);
  });
});

describe('the cleared-result marker', () => {
  /** A placeholder is a tool result of perfectly ordinary shape, and in a multi-byte script a 2 000
   *  character preview weighs more than CLEAR_MIN_BYTES — so without an identity the cold pass would
   *  spill a placeholder into a second file and nest one inside the other, losing the path to the real
   *  output. The identity has to be STRUCTURAL: a text prefix would also match a genuine output that
   *  merely quotes a placeholder (a Read of a spill file, a DelegateRead of a transcript). */
  const cleared = (toolCallId: string, text: string, timestamp: number): PiAgentMessage => ({
    role: 'toolResult', toolCallId, toolName: 'Bash', isError: false, timestamp,
    content: [{ type: 'text', text }],
    details: clearedToolResultDetails({ exitCode: 0 }, { mode: 'preview', bytes: 90_000, path: '/tmp/spill/sess-1/c.txt' }),
  });

  it('recognises a cleared result by its details, never by the text it happens to start with', () => {
    const placeholder = clearedToolResultPlaceholder('/tmp/spill/sess-1/c.txt', 90_000, 'preview text');
    expect(isClearedToolResult(cleared('c', placeholder, 3_000))).toBe(true);
    // The same bytes with no marker are an ordinary result — a tool that READ a spill file produces
    // exactly this, and calling it cleared would silently exclude it from clearing for good.
    expect(isClearedToolResult(toolResult('c', placeholder, 3_000))).toBe(false);
    expect(isClearedToolResult(toolResult('c', big, 3_000))).toBe(false);
  });

  it('keeps the tool’s own details, so a diff or a shared image still renders', () => {
    const details = clearedToolResultDetails({ diff: 'a/b', sharedImage: { path: '/x.png' } },
      { mode: 'time', bytes: 10, path: '/p' });
    expect(details.diff).toBe('a/b');
    expect(details.sharedImage).toEqual({ path: '/x.png' });
  });

  it('is what keeps a large placeholder out of the next selection', () => {
    const messages = [
      user('one', T0), assistant('a', T0 + 1), cleared('c1', big, T0 + 2),
      user('two', T0 + 3), user('three', T0 + 4),
    ];
    expect(selectClearableToolResults(messages, new Set())).toEqual([]);
    // Control: the identical history without the marker really does select that result.
    const unmarked = [...messages];
    unmarked[2] = toolResult('c1', big, T0 + 2);
    expect(selectClearableToolResults(unmarked, new Set()).map((r) => r.toolCallId)).toEqual(['c1']);
  });
});

describe('the preview a placeholder quotes', () => {
  const PATH = '/tmp/spill/sess-1/call-1.v1-preview-90000.txt';

  it('is unchanged for ASCII output — the same 2 000 characters as before', () => {
    const text = 'a'.repeat(SPILL_PREVIEW_CHARS + 500);
    expect(spillPreview(text, PATH, 90_000)).toBe(text.slice(0, SPILL_PREVIEW_CHARS));
  });

  /** The bound is what makes a ROLLBACK safe: a build without the marker recognises a cleared result
   *  only by its size, so a placeholder at or above CLEAR_MIN_BYTES would be spilled again and nested. */
  it('is trimmed until the whole placeholder fits under the clearing threshold', () => {
    const text = '日'.repeat(SPILL_PREVIEW_CHARS);
    const preview = spillPreview(text, PATH, 90_000);
    expect(preview.length).toBeLessThan(SPILL_PREVIEW_CHARS);
    expect(Buffer.byteLength(clearedToolResultPlaceholder(PATH, 90_000, preview), 'utf8'))
      .toBeLessThan(CLEAR_MIN_BYTES);
    // Control: the unbounded slice really is a clearing candidate.
    expect(Buffer.byteLength(clearedToolResultPlaceholder(PATH, 90_000, text), 'utf8'))
      .toBeGreaterThanOrEqual(CLEAR_MIN_BYTES);
  });

  it('handles a short output without trimming anything', () => {
    expect(spillPreview('tiny', PATH, 4)).toBe('tiny');
  });
});

describe('cacheColdAtTurnStart', () => {
  it('is false while the conversation is active and true after an idle gap', () => {
    const active: PiAgentMessage[] = [user('one', T0), assistant('a', T0 + 1_000), user('two', T0 + 5_000)];
    expect(cacheColdAtTurnStart(active, IDLE, T0 + 5_000)).toBe(false);
    const idle: PiAgentMessage[] = [user('one', T0), assistant('a', T0 + 1_000), user('two', T0 + IDLE + 2_000)];
    expect(cacheColdAtTurnStart(idle, IDLE, T0 + IDLE + 2_000)).toBe(true);
  });

  it('is false for the very first user message (nothing to compare against)', () => {
    expect(cacheColdAtTurnStart([user('one', T0)], IDLE, T0)).toBe(false);
  });

  it('uses the real user timestamp when a recalled-memory meta message is appended', () => {
    const recalled = { ...user('recalled memory', T0 + IDLE + 2_001), isMeta: true };
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('a', T0 + 1_000), user('two', T0 + IDLE + 2_000), recalled,
    ];

    expect(cacheColdAtTurnStart(messages, IDLE, T0 + IDLE + 2_000)).toBe(true);
  });

  it('bounds a future-stamped prompt by now (clock skew can only close the gate, never open it)', () => {
    // The prompt claims a huge idle gap, but the clock says only 1s has passed — the gap is capped
    // by `now`, so the gate stays closed.
    const skewed: PiAgentMessage[] = [user('one', T0), assistant('a', T0 + 1_000), user('two', T0 + 10 * IDLE)];
    expect(cacheColdAtTurnStart(skewed, IDLE, T0 + 2_000)).toBe(false);
    // With an honest clock the same timestamps open the gate.
    expect(cacheColdAtTurnStart(skewed, IDLE, T0 + 10 * IDLE)).toBe(true);
  });
});

describe('applyToolResultClearing', () => {
  it('replaces content with the placeholder, never mutates input, is idempotent', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1), user('two', T0 + 2), user('three', T0 + 3),
    ];
    const snapshot = structuredClone(messages);
    const placeholder = clearedToolResultPlaceholder('/tmp/spill/sess-1/old-big.v1-time-9.txt', big.length);
    const once = applyToolResultClearing(messages, new Map([[1, placeholder]]));
    expect(messages).toEqual(snapshot);
    expect(once[1]).toEqual({ ...messages[1], content: [{ type: 'text', text: placeholder }] });
    expect(once[0]).toBe(messages[0]);
    expect(applyToolResultClearing(once, new Map([[1, placeholder]]))).toBe(once);
  });
});

describe('installToolResultClearing', () => {
  it('does nothing while the conversation stays active', async () => {
    const h = harness();
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000), toolResult('prev-big', big, T0 + 3_000),
      user('three', T0 + 4_000),
    ];
    const result = await h.transform(messages);
    expect(result).toEqual(messages);
    expect(h.writes.size).toBe(0);
  });

  it('clears large old results after an idle gap, spills full text first, keeps recent turns', async () => {
    const h = harness();
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000), toolResult('old-small', small, T0 + 2_000),
      user('two', T0 + 3_000), toolResult('prev-big', big, T0 + 4_000),
      user('three', T0 + IDLE + 5_000),
    ];
    const result = await h.transform(messages);
    const path = spillPath(h, 'old-big');
    expect(h.writes.get(path)).toBe(big);
    expect(result[1]).toEqual({
      ...messages[1],
      content: [{ type: 'text', text: clearedToolResultPlaceholder(path, big.length) }],
    });
    // Small results and the two trailing turns are untouched.
    expect(result[2]).toBe(messages[2]);
    expect(result[4]).toBe(messages[4]);
  });

  it('latch keeps a cleared result cleared forever, with a byte-identical placeholder', async () => {
    const h = harness();
    const turn3: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const clearedOnce = await h.transform(turn3);
    // The conversation continues actively (small gaps — gate closed): the placeholder must persist.
    const turn4: PiAgentMessage[] = [...turn3, assistant('ok', T0 + IDLE + 4_000), user('four', T0 + IDLE + 5_000)];
    const clearedTwice = await h.transform(turn4);
    expect(clearedTwice[1]).toEqual(clearedOnce[1]);
    const text1 = JSON.stringify(clearedOnce[1]);
    const text2 = JSON.stringify(clearedTwice[1]);
    expect(text2).toBe(text1);
  });

  it('prefix stability: a warm pass never rewrites anything, a cold pass only appends clearings', async () => {
    const h = harness();
    // Turns 1–3 active: outputs must be byte-identical to inputs every single pass.
    const turns: PiAgentMessage[][] = [
      [user('one', T0), toolResult('r1', big, T0 + 1_000)],
      [user('one', T0), toolResult('r1', big, T0 + 1_000), assistant('a1', T0 + 2_000), user('two', T0 + 3_000)],
      [user('one', T0), toolResult('r1', big, T0 + 1_000), assistant('a1', T0 + 2_000), user('two', T0 + 3_000), toolResult('r2', big, T0 + 4_000)],
    ];
    for (const turn of turns) {
      expect(JSON.stringify(await h.transform(turn))).toBe(JSON.stringify(turn));
    }
    // Idle gap, then turn 4: everything before the previous user turn is now cleared, but every pass
    // AFTER that must reproduce the cleared bytes exactly.
    const turn4: PiAgentMessage[] = [...turns[2], user('three', T0 + IDLE + 5_000)];
    const cleared4 = await h.transform(turn4);
    expect(JSON.stringify(cleared4[1])).toContain('Older tool result cleared');
    const turn5: PiAgentMessage[] = [...turn4, assistant('a3', T0 + IDLE + 6_000), user('four', T0 + IDLE + 7_000)];
    const cleared5 = await h.transform(turn5);
    // The shared prefix (turn4's whole array) is byte-identical between the two passes.
    expect(JSON.stringify(cleared5.slice(0, cleared4.length))).toBe(JSON.stringify(cleared4));
  });

  it('does not clear when the spill write fails, and retries only at the NEXT idle epoch', async () => {
    let calls = 0;
    const h = harness({
      writeSpill: async () => { calls += 1; throw Object.assign(new Error('readonly'), { code: 'EACCES' }); },
    });
    const turn3: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const first = await h.transform(turn3);
    expect(JSON.stringify(first[1])).toContain('xxxx'); // still full content
    expect(calls).toBe(1);
    // The gate stays open for the whole turn, but a mid-turn retry would rewrite the prefix this
    // pass just paid to re-cache — so the failed id is skipped until the next gate OPENING.
    await h.transform(turn3);
    expect(calls).toBe(1);
    // The conversation continues actively (gate closes on a fresh user message) and then idles again
    // (gate re-opens): only NOW is the retry allowed.
    const turn4: PiAgentMessage[] = [...turn3, assistant('ok', T0 + IDLE + 4_000), user('four', T0 + IDLE + 5_000)];
    await h.transform(turn4);
    expect(calls).toBe(1);
    const turn5: PiAgentMessage[] = [
      ...turn4, assistant('ok2', T0 + IDLE + 6_000), user('five', T0 + 2 * IDLE + 7_000),
    ];
    await h.transform(turn5);
    expect(calls).toBe(2);
  });

  it('EEXIST latches only when the on-disk spill matches the output byte-for-byte', async () => {
    const matching = harness({
      writeSpill: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      readSpill: async () => big, // a genuine pre-respawn spill of this very output
    });
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const result = await matching.transform(messages);
    expect(JSON.stringify(result[1])).toContain('Older tool result cleared');

    // A foreign file at the path (e.g. written by the session itself) must NOT be latched: the
    // placeholder would point at text that was never the tool's output.
    let calls = 0;
    const foreign = harness({
      writeSpill: async () => { calls += 1; throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      readSpill: async () => 'something else entirely',
    });
    const kept = await foreign.transform(messages);
    expect(JSON.stringify(kept[1])).toContain('xxxx');
    await foreign.transform(messages); // same epoch — no retry spin
    expect(calls).toBe(1);
    // `wx` can never overwrite the foreign file, so retrying is pointless even at the NEXT epoch:
    // the id is skipped permanently (one warn at detection, no log spam every idle).
    const turn4: PiAgentMessage[] = [...messages, assistant('ok', T0 + IDLE + 4_000), user('four', T0 + IDLE + 5_000)];
    await foreign.transform(turn4); // gate closes
    const turn5: PiAgentMessage[] = [...turn4, assistant('ok2', T0 + IDLE + 6_000), user('five', T0 + 2 * IDLE + 7_000)];
    const reopened = await foreign.transform(turn5); // gate re-opens
    expect(calls).toBe(1);
    expect(JSON.stringify(reopened[1])).toContain('xxxx'); // still full content, still not cleared
  });

  it('a throwing readSpill is treated as a mismatch (mismatch handling must never take the turn down)', async () => {
    const h = harness({
      writeSpill: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      readSpill: async () => { throw new Error('disk on fire'); },
    });
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const result = await h.transform(messages);
    expect(JSON.stringify(result[1])).toContain('xxxx'); // full content kept, no rejection
  });

  it('clears nothing when the cut lands on the first message (exactly two user turns)', async () => {
    const h = harness();
    // Two user messages with the first at index 0 → cut = 0 → nothing is eligible, even when idle.
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + IDLE + 2_000),
    ];
    const result = await h.transform(messages);
    expect(result).toBe(messages);
    expect(h.writes.size).toBe(0);
  });

  it('replaces image blocks too (image stripping already turned history images into text upstream)', async () => {
    const h = harness();
    const withImage: PiAgentMessage = {
      role: 'toolResult', toolCallId: 'old-img', toolName: 'Read', isError: false, timestamp: T0 + 1_000,
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: big }],
    };
    const messages: PiAgentMessage[] = [
      user('one', T0), withImage,
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const result = await h.transform(messages);
    const content = (result[1] as { content: { type: string; text?: string }[] }).content;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toContain('Older tool result cleared');
    // The spill carries the text blocks; image bytes never hit the spill file (they were stripped
    // upstream in the real pipeline — the factory installs this hook after historyImageStripping).
    expect(h.writes.get(spillPath(h, 'old-img'))).toBe(big);
  });

  it('composes with a pre-existing transformContext and survives a missing agent seam', async () => {
    const calls: string[] = [];
    const session = {
      agent: {
        transformContext: async (m: PiAgentMessage[]): Promise<PiAgentMessage[]> => { calls.push('previous'); return m; },
      },
    };
    installToolResultClearing(session, 'sess-1', { idleMs: IDLE, writeSpill: async () => undefined });
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000), user('two', T0 + 2_000), user('three', T0 + IDLE + 3_000),
    ];
    const result = await session.agent.transformContext!(messages);
    expect(calls).toEqual(['previous']);
    expect(JSON.stringify(result[1])).toContain('Older tool result cleared');
    expect(() => installToolResultClearing({}, 'sess-1')).not.toThrow();
  });

});

const TIME = { mode: 'time' as const, bytes: 42 };

describe('latch restoration across a respawn', () => {
  /** A whole daemon restart, modelled honestly: a NEW installation over the SAME disk, given the SAME
   *  history the store would rehydrate (results still FULL — the module only ever edits the egress copy).
   *  The latch lives in a closure, so the second install starts empty exactly as the real one does. */
  const restartOver = (disk: Map<string, string>, now?: () => number) => {
    const session: Harness['session'] = { agent: {} };
    installToolResultClearing(session, 'sess-1', {
      idleMs: IDLE,
      ...(now ? { now } : {}),
      spillDir: '/tmp/spill/sess-1',
      writeSpill: async (p, t) => {
        if (disk.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        disk.set(p, t);
      },
      readSpill: async (p) => disk.get(p) ?? null,
      listSpill: async () => [...disk.keys()].map((p) => p.slice('/tmp/spill/sess-1/'.length)),
    });
    return (m: PiAgentMessage[]) => session.agent.transformContext!(m);
  };

  /** Three text blocks. `bytes` sums the BLOCKS while the spill file joins them with '\n', so the file is
   *  2 bytes larger — the case that proves the byte count is read from the name and not measured off the
   *  file. A single-block result would hide the difference. */
  const multiBlock = (toolCallId: string, timestamp: number): PiAgentMessage => ({
    role: 'toolResult', toolCallId, toolName: 'Bash', isError: false, timestamp,
    content: [{ type: 'text', text: big }, { type: 'text', text: big }, { type: 'text', text: big }],
  } as PiAgentMessage);

  const history = (): PiAgentMessage[] => [
    user('one', T0),
    toolResult('old-big', big, T0 + 1_000),
    multiBlock('old-multi', T0 + 1_500),
    user('two', T0 + 2_000),
    assistant('working', T0 + 3_000),
    user('three', T0 + IDLE + 4_000),
  ];

  it('re-sends byte-identical placeholders after a restart', async () => {
    const disk = new Map<string, string>();
    const before = await restartOver(disk)(history());
    const timeText = (before[1] as { content: { text: string }[] }).content[0]!.text;
    const multiText = (before[2] as { content: { text: string }[] }).content[0]!.text;
    expect(timeText).toContain('Older tool result cleared');
    // The multi-block result's own placeholder must quote the summed BLOCK bytes, not the file size.
    expect(multiText).toContain(`${big.length * 3} bytes`);

    const after = await restartOver(disk)(history());
    // Exact string equality on purpose: "contains a placeholder" would pass even if the byte count or the
    // path differed, and a single differing byte is a full re-cache of the whole conversation.
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toBe(timeText);
    expect((after[2] as { content: { text: string }[] }).content[0]!.text).toBe(multiText);
  });

  it('does not rewrite the spill files it restored from', async () => {
    const disk = new Map<string, string>();
    await restartOver(disk)(history());
    const snapshot = new Map(disk);
    await restartOver(disk)(history());
    expect([...disk.entries()]).toEqual([...snapshot.entries()]);
  });

  it('leaves a result whole when the spill on disk is not what the message says', async () => {
    const disk = new Map<string, string>();
    await restartOver(disk)(history());
    for (const key of disk.keys()) disk.set(key, 'tampered');
    const after = await restartOver(disk)(history());
    // Failing closed costs one re-cache; the alternative would be a placeholder describing text that was
    // never the tool's output.
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toBe(big);
  });

  it('ignores legacy unversioned spills left by an older build', async () => {
    const disk = new Map<string, string>([['/tmp/spill/sess-1/old-big.txt', big]]);
    const after = await restartOver(disk)(history());
    // The legacy name carries no byte count, so it cannot rebuild the placeholder; the result is cleared
    // afresh under a v1 name instead.
    expect(disk.has('/tmp/spill/sess-1/old-big.txt')).toBe(true);
    expect([...disk.keys()].some((p) => p.startsWith('/tmp/spill/sess-1/old-big.v1-'))).toBe(true);
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toContain('Older tool result cleared');
  });

  /** The restart that actually matters: the user comes back and types IMMEDIATELY, so the cache is still
   *  warm and the time gate stays SHUT. Clearing afresh is not an option then — rewriting a warm prefix is
   *  the one thing this module must never do — which makes restoration the only path to a placeholder.
   *  Any test run with the gate open proves nothing about restoration: the result would be re-cleared
   *  anyway and the placeholder would appear either way. */
  const warmNow = () => T0 + IDLE + 6_000;

  it('restores with the time gate SHUT, where re-clearing is not an option', async () => {
    const disk = new Map<string, string>();
    const before = await restartOver(disk)(history());
    const timeText = (before[1] as { content: { text: string }[] }).content[0]!.text;
    const filesAfterFirst = new Map(disk);

    const after = await restartOver(disk, warmNow)(history());
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toBe(timeText);
    // Nothing was re-spilled: the placeholder came from the latch, not from a fresh clearing pass.
    expect([...disk.entries()]).toEqual([...filesAfterFirst.entries()]);
  });

  // A stale spill sits beside a matching one when an earlier restoration failed and the cold gate then
  // cleared the same result again. Picking one candidate up front would forfeit the restoration whenever
  // the guess landed on the stale file — and forfeit it on every restart from then on.
  it('keeps looking past a stale spill to the one that matches', async () => {
    const disk = new Map<string, string>([
      [`/tmp/spill/sess-1/old-big.v1-time-${big.length + 999}.txt`, 'stale content from an older run'],
    ]);
    await restartOver(disk)(history());
    const after = await restartOver(disk, warmNow)(history());
    const text = (after[1] as { content: { text: string }[] }).content[0]!.text;
    expect(text).toContain('Older tool result cleared');
    expect(text).toContain(`${big.length} bytes`); // the real spill's count, not the stale name's
  });

  it('prefers the time spill when both a time and a preview file exist for one result', async () => {
    const disk = new Map<string, string>([
      [`/tmp/spill/sess-1/old-big.v1-preview-${big.length}.txt`, big],
      [`/tmp/spill/sess-1/old-big.v1-time-${big.length}.txt`, big],
    ]);
    const after = await restartOver(disk)(history());
    // Refusing to choose would mean paying a full re-cache on every restart from then on, forever.
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toContain('Older tool result cleared');
  });
});

describe('duplicate toolCallIds', () => {
  // Ids are minted by the model, and sequential-style ids (`call_0`) reset per turn — a long history can
  // genuinely repeat one. The invariant under test: an occurrence already sent as a placeholder NEVER
  // reverts to full text, whatever else carries the same id.
  it('keeps the cleared occurrence cleared when the same id reappears with different content', async () => {
    const h = harness();
    const cleared3: PiAgentMessage[] = [
      user('one', T0), toolResult('dup', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const before = await h.transform(cleared3);
    const placeholderText = JSON.stringify(before[1]);
    expect(placeholderText).toContain('Older tool result cleared');
    // The same id comes back as a FRESH result of the current run.
    const fresh = toolResult('dup', 'fresh content the model must still see', T0 + IDLE + 4_000);
    const grown: PiAgentMessage[] = [...cleared3, assistant('calling', T0 + IDLE + 3_500), fresh];
    const after = await h.transform(grown);
    // A keyed last-wins map would revert index 1 to full text here — a warm-prefix rewrite.
    expect(JSON.stringify(after[1])).toBe(placeholderText);
    // …and the fresh occurrence is not the one that was spilled, so the old placeholder (which
    // describes DIFFERENT content) must not be applied to it either.
    expect(after[5]).toBe(fresh);
    // The choice is stable on the next pass too.
    const again = await h.transform([...grown, user('four', T0 + IDLE + 5_000)]);
    expect(JSON.stringify(again[1])).toBe(placeholderText);
    expect(again[5]).toBe(fresh);
  });

  it('hands the placeholder to the occurrence that was spilled, not blindly to the first', async () => {
    const h = harness();
    // The FIRST occurrence of the id is too small to ever clear; the SECOND is what the time trigger
    // spilled. Keyed first-wins on the id alone would misapply the placeholder to the small one.
    const messages: PiAgentMessage[] = [
      user('zero', T0), toolResult('dup', small, T0 + 500),
      user('one', T0 + 1_000), toolResult('dup', big, T0 + 1_500),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const result = await h.transform(messages);
    expect(result[1]).toBe(messages[1]); // the small occurrence is untouched
    expect(JSON.stringify(result[3])).toContain('Older tool result cleared');
  });
});

describe('durable latch across a respawn (store-backed)', () => {
  /** A daemon restart with the latch store in play: a NEW installation over the SAME disk and the SAME
   *  BrainStore, exactly as the factory wires it. */
  const restartOver = (
    disk: Map<string, string>,
    latchStore: ToolResultLatchStore | undefined,
    now?: () => number,
  ) => {
    const session: Harness['session'] = { agent: {} };
    installToolResultClearing(session, 'sess-1', {
      idleMs: IDLE,
      ...(now ? { now } : {}),
      ...(latchStore ? { latchStore } : {}),
      spillDir: '/tmp/spill/sess-1',
      writeSpill: async (p, t) => {
        if (disk.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        disk.set(p, t);
      },
      readSpill: async (p) => disk.get(p) ?? null,
      listSpill: async () => [...disk.keys()].map((p) => p.slice('/tmp/spill/sess-1/'.length)),
    });
    return (m: PiAgentMessage[]) => session.agent.transformContext!(m);
  };

  const storeAdapter = (store: BrainStore): ToolResultLatchStore => ({
    load: () => store.toolResultSpills('sess-1'),
    save: (entry: PersistedToolResultLatch) => { store.upsertToolResultSpill('sess-1', entry); },
    remove: (toolCallId, occurredAt) => { store.deleteToolResultSpill('sess-1', toolCallId, occurredAt); },
  });

  /** An oversized fresh tool result CARRYING AN IMAGE, as PI delivers it live: the image block
   *  contributes nothing to the spill text (only text blocks do), which is exactly what makes its
   *  rehydrated form unmatchable by text equality. */
  const liveImageResult: PiAgentMessage = {
    role: 'toolResult', toolCallId: 'shot', toolName: 'Screenshot', isError: false, timestamp: T0 + 2_000,
    content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: oversized }],
  } as PiAgentMessage;
  /** The turn in which the cold gate clears that result: two user turns follow it, and the last one lands
   *  a full idle threshold after the previous message. */
  const liveTurn: PiAgentMessage[] = [
    user('one', T0), assistant('calling', T0 + 1_000), liveImageResult,
    user('two', T0 + 3_000), user('three', T0 + IDLE + 4_000),
  ];
  /** The same result as `rehydrate` replays it after a crash: persistence externalized the image and
   *  `withoutExternalizedImages` replaced it with the placeholder TEXT block — the text of the very
   *  same result now differs from what was spilled. The new prompt lands after the settled history. */
  const rehydratedTurn = (promptAt: number): PiAgentMessage[] => [
    user('one', T0), assistant('calling', T0 + 1_000),
    {
      ...liveImageResult,
      content: [{ type: 'text', text: HISTORY_IMAGE_PLACEHOLDER }, { type: 'text', text: oversized }],
    } as PiAgentMessage,
    user('two', T0 + 3_000), user('three', promptAt),
  ];
  /** Immediately after the crash — inside the idle threshold, so the time gate is SHUT and re-clearing
   *  afresh is not an option: restoration is the only path to a placeholder. */
  const warmNow = () => T0 + 10_000;

  it('re-sends a byte-identical placeholder after a respawn even when rehydration changed the text', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    const disk = new Map<string, string>();
    const before = await restartOver(disk, storeAdapter(store))(liveTurn);
    const placeholder = (before[2] as { content: { text: string }[] }).content[0]!.text;
    expect(placeholder).toContain('Older tool result cleared');
    expect(disk.size).toBe(1);

    const after = await restartOver(disk, storeAdapter(store), warmNow)(rehydratedTurn(warmNow()));
    // Byte equality is the whole point: one differing byte re-caches the entire conversation. The
    // file-equality fallback alone CANNOT restore this (the drifted text matches no spill), which is
    // why the store rows exist — see the refutation test below.
    expect((after[2] as { content: { text: string }[] }).content[0]!.text).toBe(placeholder);
    // Nothing was re-spilled under a new name either — the second warm rewrite the old design risked.
    expect(disk.size).toBe(1);
  });

  it('REFUTATION CONTROL: without the store, the drifted text really does defeat the file restore', async () => {
    // Not a wanted behaviour — this pins down that the store-backed test above fails for the exact
    // reason it claims to guard against, so a mutation that drops the store restore goes red there.
    const disk = new Map<string, string>();
    await restartOver(disk, undefined)(liveTurn);
    const after = await restartOver(disk, undefined, warmNow)(rehydratedTurn(warmNow()));
    expect((after[2] as { content: { text: string }[] }).content[1]?.text).toBe(oversized); // full again
  });

  it('restores from the store even when the spill file is gone — stability beats a dangling path', async () => {
    // A swept spill file cannot un-send the placeholder the provider already cached: re-sending those
    // exact bytes keeps the prefix stable, and the durable transcript still holds the full text. The
    // model merely loses the Read-back path, which full re-sending would not restore either.
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    const disk = new Map<string, string>();
    const before = await restartOver(disk, storeAdapter(store))(liveTurn);
    const placeholder = (before[2] as { content: { text: string }[] }).content[0]!.text;
    disk.clear();
    const after = await restartOver(disk, storeAdapter(store), warmNow)(rehydratedTurn(warmNow()));
    expect((after[2] as { content: { text: string }[] }).content[0]!.text).toBe(placeholder);
  });

  it('a file-restored latch graduates to the store, so the next restart no longer depends on the text', async () => {
    // Process 1 predates the table (no latch store) and clears on the time trigger; process 2 has the
    // store and restores from the FILE (text still matches); process 3 sees drifted text and can only
    // succeed through the rows process 2 wrote.
    const timeHistory: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const disk = new Map<string, string>();
    const before = await restartOver(disk, undefined)(timeHistory);
    const placeholder = (before[1] as { content: { text: string }[] }).content[0]!.text;

    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    await restartOver(disk, storeAdapter(store), () => T0 + IDLE + 4_000)(timeHistory);
    const path = `/tmp/spill/sess-1/old-big.v1-time-${big.length}.txt`;
    expect(store.toolResultSpills('sess-1')).toEqual([{
      toolCallId: 'old-big',
      occurredAt: T0 + 1_000, // the graduated row adopts the occurrence's own timestamp
      mode: 'time', bytes: big.length, preview: null, path,
      placeholder: clearedToolResultPlaceholder(path, big.length),
      createdAt: expect.any(String) as unknown as string,
    }]);

    const drifted: PiAgentMessage[] = [
      user('one', T0),
      {
        role: 'toolResult', toolCallId: 'old-big', toolName: 'Bash', isError: false, timestamp: T0 + 1_000,
        content: [{ type: 'text', text: HISTORY_IMAGE_PLACEHOLDER }, { type: 'text', text: big }],
      } as PiAgentMessage,
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
      user('four', T0 + IDLE + 5_000),
    ];
    const after = await restartOver(disk, storeAdapter(store), () => T0 + IDLE + 5_000)(drifted);
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toBe(placeholder);
  });

  // THE deployed defect this occurrence keying exists to end (critical): the latch used to be keyed by
  // toolCallId alone, so once a compaction removed the cleared occurrence, its surviving row captured a
  // brand-new result that merely reused the id (sequential styles like `call_0` reset every turn on
  // deepseek/qwen/kimi) — the model never saw its own tool output, only a placeholder pointing at
  // another call's spill.
  it('a stale row never captures a fresh result that reuses the id after a compaction', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    const disk = new Map<string, string>();
    const timeHistory: PiAgentMessage[] = [
      user('one', T0), toolResult('call_0', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const before = await restartOver(disk, storeAdapter(store))(timeHistory);
    expect(JSON.stringify(before[1])).toContain('Older tool result cleared');
    expect(store.toolResultSpills('sess-1')).toHaveLength(1);

    // A new process wakes to a COMPACTED history in which the model has minted `call_0` again.
    const fresh = toolResult('call_0', 'brand new output the model must actually see', T0 + IDLE + 60_000);
    const compacted: PiAgentMessage[] = [
      user('summary of the earlier conversation', T0 + IDLE + 50_000),
      assistant('calling', T0 + IDLE + 55_000),
      fresh,
    ];
    const after = await restartOver(disk, storeAdapter(store), () => T0 + IDLE + 61_000)(compacted);
    expect(after[2]).toBe(fresh); // its own full content — not the old occurrence's placeholder
    // …and the stale row is pruned, so it cannot ambush any later pass or respawn either.
    expect(store.toolResultSpills('sess-1')).toEqual([]);
  });

  it('prunes the durable row the moment its occurrence left the history, without touching live ones', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    const disk = new Map<string, string>();
    const timeHistory: PiAgentMessage[] = [
      user('one', T0), toolResult('call_0', big, T0 + 1_000), toolResult('keeper', big, T0 + 1_500),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    await restartOver(disk, storeAdapter(store))(timeHistory);
    expect(store.toolResultSpills('sess-1')).toHaveLength(2);
    // Compaction keeps `keeper`'s occurrence but drops `call_0`'s.
    const compacted: PiAgentMessage[] = [
      user('summary', T0 + IDLE + 50_000),
      toolResult('keeper', big, T0 + 1_500),
      user('next', T0 + IDLE + 51_000),
    ];
    const after = await restartOver(disk, storeAdapter(store), () => T0 + IDLE + 52_000)(compacted);
    expect(store.toolResultSpills('sess-1').map((row) => row.toolCallId)).toEqual(['keeper']);
    // The surviving occurrence still goes out as its byte-stable placeholder.
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toContain('Older tool result cleared');
  });

  it('re-sends the STORED placeholder verbatim — a renderer wording change must not rewrite history', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    // A row written by a (hypothetical) earlier build whose renderer worded the placeholder differently.
    // What the provider cached is THESE bytes; restoring anything else re-caches the whole conversation.
    const oldWording = '[v0 wording: big tool output parked at /tmp/spill/sess-1/old-big.v1-time-4196.txt]';
    store.upsertToolResultSpill('sess-1', {
      toolCallId: 'old-big', occurredAt: T0 + 1_000, mode: 'time', bytes: big.length,
      preview: null, path: `/tmp/spill/sess-1/old-big.v1-time-${big.length}.txt`, placeholder: oldWording,
    });
    const history: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1_000),
      user('two', T0 + 2_000),
      assistant('working', T0 + 3_000),
      user('three', T0 + 4_000), // warm — restoration is the only path to a placeholder
    ];
    const after = await restartOver(new Map(), storeAdapter(store), () => T0 + 5_000)(history);
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toBe(oldWording);
  });
});

describe('occurrence keying within one process', () => {
  // The in-process half of the critical defect: no respawn needed — the latch map itself used to be
  // keyed by id, so a compaction followed by an id reuse inside the same daemon lifetime swapped the
  // fresh result for the old placeholder on the very next pass.
  it('a fresh result reusing a cleared id after an in-memory compaction keeps its own content', async () => {
    const h = harness();
    const before: PiAgentMessage[] = [
      user('one', T0), toolResult('call_0', big, T0 + 1_000),
      user('two', T0 + 2_000),
      user('three', T0 + IDLE + 3_000),
    ];
    const cleared = await h.transform(before);
    expect(JSON.stringify(cleared[1])).toContain('Older tool result cleared');

    const fresh = toolResult('call_0', 'fresh content the model must still see', T0 + IDLE + 5_000);
    const compacted: PiAgentMessage[] = [
      user('summary of the earlier conversation', T0 + IDLE + 3_000),
      assistant('calling', T0 + IDLE + 4_000),
      fresh,
    ];
    const after = await h.transform(compacted);
    expect(after[2]).toBe(fresh);
  });
});

describe('legacy rows (occurred_at 0) written by the deployed pre-occurrence build', () => {
  const legacyRestart = (store: BrainStore, now: () => number) => {
    const session: Harness['session'] = { agent: {} };
    installToolResultClearing(session, 'sess-1', {
      idleMs: IDLE,
      now,
      spillDir: '/tmp/spill/sess-1',
      writeSpill: async () => { throw new Error('nothing may be spilled in these tests'); },
      readSpill: async () => null,
      listSpill: async () => [],
      latchStore: {
        load: () => store.toolResultSpills('sess-1'),
        save: (entry) => { store.upsertToolResultSpill('sess-1', entry); },
        remove: (toolCallId, occurredAt) => { store.deleteToolResultSpill('sess-1', toolCallId, occurredAt); },
      },
    });
    return (m: PiAgentMessage[]) => session.agent.transformContext!(m);
  };
  const legacyRow = (toolCallId: string): PersistedToolResultLatch => ({
    toolCallId, occurredAt: 0, mode: 'time', bytes: big.length, preview: null,
    path: `/tmp/spill/sess-1/${toolCallId}.v1-time-${big.length}.txt`, placeholder: null,
  });

  // Legacy rows carry no occurrence timestamp, so they are matched by AGE against the row's own write
  // time: the occurrence a row was written for necessarily existed before the row did.
  it('still restores the occurrence it was written for, and graduates the row', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    store.upsertToolResultSpill('sess-1', legacyRow('old-big'));
    const start = Date.now(); // real clock: the heuristic compares against the row's created_at
    const occurredAt = start - 3 * 3_600_000 + 1_000;
    const history: PiAgentMessage[] = [
      user('one', start - 3 * 3_600_000), toolResult('old-big', big, occurredAt),
      user('two', start - 3 * 3_600_000 + 2_000),
      assistant('working', start - 2_000),
      user('three', start - 1_000), // warm gate — only restoration can produce the placeholder
    ];
    const after = await legacyRestart(store, () => start)(history);
    expect((after[1] as { content: { text: string }[] }).content[0]!.text)
      .toBe(clearedToolResultPlaceholder(`/tmp/spill/sess-1/old-big.v1-time-${big.length}.txt`, big.length));
    // The legacy row graduated to the occurrence's real key; the 0-key row is gone.
    expect(store.toolResultSpills('sess-1').map((row) => row.occurredAt)).toEqual([occurredAt]);
  });

  // The deployed data hazard, replayed against the deployed rows themselves: the occurrence was
  // compacted away, the id came back on a NEW result. Trusting the row (the old behaviour) would hand
  // the model a placeholder for output it never produced.
  it('never captures a fresh result stamped after the row itself, and prunes the row', async () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'sess-1', userId: 7, model: 'm' });
    store.upsertToolResultSpill('sess-1', legacyRow('call_0'));
    const start = Date.now();
    // Minted well after the row was written (+10 min > the matching slack) — a reused id, not the
    // occurrence the row describes.
    const fresh = toolResult('call_0', 'fresh output of a brand new call', start + 600_000);
    const compacted: PiAgentMessage[] = [
      user('summary', start + 590_000),
      assistant('calling', start + 595_000),
      fresh,
    ];
    const after = await legacyRestart(store, () => start + 601_000)(compacted);
    expect(after[2]).toBe(fresh);
    expect(store.toolResultSpills('sess-1')).toEqual([]);
  });
});

describe('toolResultSpillPath', () => {
  it('fs-encodes the toolCallId so a hostile id cannot escape the spill dir', () => {
    expect(toolResultSpillPath('/s', 'call-1', TIME)).toBe('/s/call-1.v1-time-42.txt');
    expect(toolResultSpillPath('/s', 'a/b', TIME)).toBe('/s/a%2Fb.v1-time-42.txt');
    expect(toolResultSpillPath('/s', '..', TIME)).toBe('/s/%...v1-time-42.txt');
  });

  // The byte count cannot be measured back off the file: it sums the individual text BLOCKS, while the
  // file holds them joined by '\n'. Carrying it in the name is what lets a restarted session rebuild the
  // placeholder byte-identically.
  it('carries the mode and byte count needed to rebuild the placeholder', () => {
    expect(toolResultSpillPath('/s', 'c', { mode: 'preview', bytes: 50003 })).toBe('/s/c.v1-preview-50003.txt');
  });
});

describe('persistToolOutputSpill', () => {
  const spillDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-output-spill-'));
    dirs.push(dir);
    return join(dir, 'ns');
  };

  it('writes the complete text into the spill dir, creating it, and reports its byte size', async () => {
    const dir = spillDir();
    const text = 'á'.repeat(5000); // 10 000 bytes, so the count is not the character count
    const stored = await persistToolOutputSpill(dir, 'call-1', text);

    expect(stored).toEqual({ path: join(dir, 'call-1.v1-output-10000.txt'), bytes: 10_000 });
    expect(readFileSync(stored!.path, 'utf8')).toBe(text);
  });

  it('fs-encodes the toolCallId so a hostile id cannot escape the spill dir', async () => {
    const dir = spillDir();
    const stored = await persistToolOutputSpill(dir, '../escape', 'x');
    expect(stored?.path).toBe(join(dir, '..%2Fescape.v1-output-1.txt'));
  });

  // A persisted full output is NOT the spill of the result the model received (that result carries an
  // excerpt), so restoreLatch must never offer it as a latch candidate for that toolCallId — it would
  // compare unequal, log a "no spill matches" warning and, if it ever did match, describe the result with
  // the wrong byte count.
  it('is named outside the latch descriptor grammar', async () => {
    const dir = spillDir();
    const stored = await persistToolOutputSpill(dir, 'c', 'hello');
    const name = stored!.path.slice(stored!.path.lastIndexOf('/') + 1);
    expect(parseSpillDescriptor(name, 'c')).toBeNull();
  });

  // A toolCallId is not unique on its own — sequential styles reset every turn — so a later call can land
  // on an existing name whose bytes are a DIFFERENT output of the same size. Overwriting would swap the
  // content under a path an earlier result still tells the model to read.
  it('never overwrites a different output already at its path', async () => {
    const dir = spillDir();
    const first = await persistToolOutputSpill(dir, 'call-1', 'aaaaa');
    expect(await persistToolOutputSpill(dir, 'call-1', 'bbbbb')).toBeNull();
    expect(readFileSync(first!.path, 'utf8')).toBe('aaaaa');
  });

  it('adopts an identical file instead of failing the caller', async () => {
    const dir = spillDir();
    const first = await persistToolOutputSpill(dir, 'call-1', 'aaaaa');
    expect(await persistToolOutputSpill(dir, 'call-1', 'aaaaa')).toEqual(first);
  });
});

describe('parseSpillDescriptor', () => {
  it('reads back what toolResultSpillPath wrote, for the id it was given', () => {
    expect(parseSpillDescriptor('c.v1-time-42.txt', 'c')).toEqual(TIME);
    expect(parseSpillDescriptor('c.v1-preview-7.txt', 'c')).toEqual({ mode: 'preview', bytes: 7 });
  });

  it('ignores a name belonging to a different id, and legacy unversioned spills', () => {
    expect(parseSpillDescriptor('other.v1-time-42.txt', 'c')).toBeNull();
    expect(parseSpillDescriptor('c.txt', 'c')).toBeNull(); // 379 of these exist on disk from before v1
  });

  // A future change to the preview length or the placeholder wording must mint v2 rather than silently
  // reinterpret v1 names, or a restored placeholder would differ from the one already in the cache.
  it('refuses a version it does not know', () => {
    expect(parseSpillDescriptor('c.v2-time-42.txt', 'c')).toBeNull();
  });

  it('refuses a malformed descriptor instead of guessing', () => {
    expect(parseSpillDescriptor('c.v1-time-.txt', 'c')).toBeNull();
    expect(parseSpillDescriptor('c.v1-other-42.txt', 'c')).toBeNull();
    expect(parseSpillDescriptor('c.v1-time-4x2.txt', 'c')).toBeNull();
  });
});

describe('cacheTtlMs / idleThresholdMs', () => {
  it('resolves the TTL from the same env var pi-ai reads: 60 min long, 5 min short', () => {
    expect(cacheTtlMs({ PI_CACHE_RETENTION: 'long' } as NodeJS.ProcessEnv)).toBe(60 * 60_000);
    expect(cacheTtlMs({} as NodeJS.ProcessEnv)).toBe(5 * 60_000);
  });

  it('the gate rounds the TTL UP by a minute: 61 minutes for long retention, 6 otherwise', () => {
    expect(idleThresholdMs({ PI_CACHE_RETENTION: 'long' } as NodeJS.ProcessEnv)).toBe(61 * 60_000);
    expect(idleThresholdMs({} as NodeJS.ProcessEnv)).toBe(6 * 60_000);
  });
});
