import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEAR_MIN_BYTES,
  SPILL_PREVIEW_CHARS,
  clearedToolResultDetails,
  clearedToolResultPlaceholder,
  clearingCutIndex,
  isClearedToolResult,
  spillPreview,
  selectClearableToolResults,
  toolResultSpillPath,
  persistToolOutputSpill,
} from '../../../src/brain/session/toolResultClearing.js';
import { cacheTtlMs, idleThresholdMs } from '../../../src/brain/session/cacheTiming.js';
import type { PiAgentMessage } from '../../../src/brain/session/historyImageStripping.js';

let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const T0 = 1_000_000;

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
    const selected = selectClearableToolResults(messages);
    expect(selected.map((s) => s.toolCallId)).toEqual(['old-big']);
    expect(selected[0]?.bytes).toBe(big.length);
  });

  it('selects nothing when the conversation has fewer than two user messages', () => {
    const messages: PiAgentMessage[] = [user('one', T0), toolResult('big-1', big, T0 + 1)];
    expect(clearingCutIndex(messages)).toBe(-1);
    expect(selectClearableToolResults(messages)).toEqual([]);
  });

  it('does not count a recalled-memory meta message toward retained user turns', () => {
    const recalled = { ...user('recalled memory', T0 + 4), isMeta: true };
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1),
      user('two', T0 + 2), toolResult('current-big', big, T0 + 3), recalled,
    ];

    expect(clearingCutIndex(messages)).toBe(0);
    expect(selectClearableToolResults(messages)).toEqual([]);
  });

  it('reports the occurrence timestamp a stored row is matched on', () => {
    // The id alone is not an identity: sequential styles (`call_0`) reset every turn, so a compaction can
    // let the same id come back on a completely different result and a row matched by id would then be
    // rewritten with another call's placeholder.
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('old-big', big, T0 + 1), user('two', T0 + 2), user('three', T0 + 3),
    ];
    expect(selectClearableToolResults(messages)).toEqual([
      { index: 1, toolCallId: 'old-big', occurredAt: T0 + 1, bytes: big.length },
    ]);
  });

  it('measures the retention in user turns, so a shorter count reaches further back', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0), toolResult('a', big, T0 + 1),
      user('two', T0 + 2), toolResult('b', big, T0 + 3),
      user('three', T0 + 4),
    ];
    // Two turns kept: only the first turn's result is old enough.
    expect(selectClearableToolResults(messages).map((r) => r.toolCallId)).toEqual(['a']);
    // One turn kept — what the turn-start pass uses, before the user's new message is admitted.
    expect(selectClearableToolResults(messages, 1).map((r) => r.toolCallId)).toEqual(['a', 'b']);
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
    expect(selectClearableToolResults(messages)).toEqual([]);
    // Control: the identical history without the marker really does select that result.
    const unmarked = [...messages];
    unmarked[2] = toolResult('c1', big, T0 + 2);
    expect(selectClearableToolResults(unmarked).map((r) => r.toolCallId)).toEqual(['c1']);
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

describe('toolResultSpillPath', () => {
  const TIME = { mode: 'time' as const, bytes: 42 };

  it('fs-encodes the toolCallId so a hostile id cannot escape the spill dir', () => {
    expect(toolResultSpillPath('/s', 'call-1', TIME)).toBe('/s/call-1.v1-time-42.txt');
    expect(toolResultSpillPath('/s', 'a/b', TIME)).toBe('/s/a%2Fb.v1-time-42.txt');
    expect(toolResultSpillPath('/s', '..', TIME)).toBe('/s/%...v1-time-42.txt');
  });

  // The mode and the byte count are in the name for UNIQUENESS: two clearings of the same id must not
  // collide on one file, and a write-once spill can then adopt an identical survivor safely. Nothing
  // parses them back out.
  it('carries the mode and byte count that make the name unique', () => {
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

  // A persisted full output is NOT the spill of a cleared result (that result carries an excerpt), so it
  // is named outside the `time|preview` grammar and can never collide with one.
  it('is named outside the cleared-result grammar', async () => {
    const dir = spillDir();
    const stored = await persistToolOutputSpill(dir, 'c', 'hello');
    const name = stored!.path.slice(stored!.path.lastIndexOf('/') + 1);
    expect(name).toBe('c.v1-output-5.txt');
    expect(name).not.toMatch(/\.v1-(time|preview)-/);
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
