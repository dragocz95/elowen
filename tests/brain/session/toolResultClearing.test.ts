import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEAR_MIN_BYTES,
  SPILL_MAX_RESULT_BYTES,
  SPILL_PREVIEW_CHARS,
  TOOL_RESULT_GROUP_BUDGET_BYTES,
  applyToolResultClearing,
  cacheColdAtTurnStart,
  cacheTtlMs,
  clearedToolResultPlaceholder,
  clearingCutIndex,
  idleThresholdMs,
  installToolResultClearing,
  selectBudgetedToolResults,
  selectClearableToolResults,
  selectOversizedToolResults,
  setSpillMaxResultBytes,
  setToolResultGroupBudget,
  toolResultSpillPath,
  toolResultOccurrenceKey,
  parseSpillDescriptor,
  persistToolOutputSpill,
} from '../../../src/brain/session/toolResultClearing.js';
import type { PersistedToolResultLatch, ToolResultLatchStore } from '../../../src/brain/session/toolResultClearing.js';
import { setSpillNamespaceResolver, toolResultSpillDir } from '../../../src/shared/paths.js';
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

/** Which results reached disk, by id — the behaviour these tests care about, independent of the file name. */
function spilledIds(h: Harness): string[] {
  return [...h.writes.keys()].map((p) => p.slice('/tmp/spill/sess-1/'.length).split('.v1-')[0]!).sort();
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

describe('selectOversizedToolResults', () => {
  it('selects only current-run results above the size trigger, with an id and not already latched', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0),
      toolResult('older-oversized', oversized, T0 + 1), // already sent to the provider — time gate's job
      user('two', T0 + 2),
      toolResult('fresh-big-but-under', big, T0 + 3),
      toolResult('fresh-oversized', oversized, T0 + 4),
      { role: 'toolResult', toolCallId: '', toolName: 'Bash', content: [{ type: 'text', text: oversized }], isError: false, timestamp: T0 + 5 } as PiAgentMessage,
    ];
    const selected = selectOversizedToolResults(messages, new Set());
    expect(selected.map((s) => s.toolCallId)).toEqual(['fresh-oversized']);
    expect(selected[0]?.bytes).toBe(oversized.length);
    expect(selectOversizedToolResults(messages, new Set([toolResultOccurrenceKey('fresh-oversized', T0 + 4)]))).toEqual([]);
  });

  it('does not select a result exactly at the threshold', () => {
    const exact = 'z'.repeat(SPILL_MAX_RESULT_BYTES);
    const messages: PiAgentMessage[] = [user('one', T0), toolResult('exact', exact, T0 + 1)];
    expect(selectOversizedToolResults(messages, new Set())).toEqual([]);
  });

  it('applies the live resolver threshold, not just the default constant', () => {
    // Comfortably UNDER the default trigger — left in context while the default is in force.
    const under = 'z'.repeat(SPILL_MAX_RESULT_BYTES - 10_000);
    const messages: PiAgentMessage[] = [user('one', T0), toolResult('fresh', under, T0 + 1)];
    expect(selectOversizedToolResults(messages, new Set())).toEqual([]);
    // Lower the resolver below that size and the SAME result now spills. If the call site still read the
    // constant this assertion would fail — the resolver would be ignored and nothing selected.
    setSpillMaxResultBytes(() => under.length - 100);
    try {
      const selected = selectOversizedToolResults(messages, new Set());
      expect(selected.map((s) => s.toolCallId)).toEqual(['fresh']);
      expect(selected[0]?.bytes).toBe(under.length);
    } finally {
      setSpillMaxResultBytes(() => SPILL_MAX_RESULT_BYTES);
    }
  });
});

/** One wire-level group of medium results: every member is under the per-result trigger, but together
 *  they blow the aggregate budget — the exact shape (parallel searches in one turn) the budget exists for.
 *  Descending sizes so "largest first" is observable. */
const GROUP_BYTES = [49_000, 48_000, 47_000, 46_000, 45_000, 15_000];
const groupTotal = GROUP_BYTES.reduce((sum, bytes) => sum + bytes, 0);
const groupResult = (index: number, timestamp: number): PiAgentMessage =>
  toolResult(`g-${index}`, String.fromCharCode(97 + index).repeat(GROUP_BYTES[index]), timestamp);
/** The occurrence key of groupResult(index, timestamp) — selections speak in occurrence keys now. */
const gKey = (index: number, timestamp: number): string => toolResultOccurrenceKey(`g-${index}`, timestamp);
/** A whole over-budget group delivered in one turn, at indices 2..7. */
const overBudgetTurn = (): PiAgentMessage[] => [
  user('one', T0), assistant('calling', T0 + 1_000),
  ...GROUP_BYTES.map((_, index) => groupResult(index, T0 + 2_000 + index)),
];

describe('selectBudgetedToolResults', () => {
  it('is a meaningful setup: every member is under the per-result trigger, the group is over budget', () => {
    expect(GROUP_BYTES.every((bytes) => bytes <= SPILL_MAX_RESULT_BYTES)).toBe(true);
    expect(groupTotal).toBeGreaterThan(TOOL_RESULT_GROUP_BUDGET_BYTES);
  });

  it('leaves a group under budget completely alone, but records every member as decided', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      groupResult(3, T0 + 2_000), groupResult(4, T0 + 3_000), groupResult(5, T0 + 4_000),
    ];
    const selected = selectBudgetedToolResults(messages, new Set(), new Set());
    expect(selected.spill).toEqual([]);
    // Decided even though nothing spilled: these bytes are on their way to the provider, so the layer
    // must never revisit them.
    expect([...selected.decided].sort()).toEqual(
      [gKey(3, T0 + 2_000), gKey(4, T0 + 3_000), gKey(5, T0 + 4_000)].sort(),
    );
  });

  it('spills the largest members first, only until the group is back under budget', () => {
    const selected = selectBudgetedToolResults(overBudgetTurn(), new Set(), new Set());
    expect(selected.spill.map((item) => item.toolCallId)).toEqual(['g-0', 'g-1']);
    const remaining = groupTotal - selected.spill.reduce((sum, item) => sum + item.bytes, 0);
    expect(remaining).toBeLessThanOrEqual(TOOL_RESULT_GROUP_BUDGET_BYTES);
    // One spill fewer would NOT have been enough — nothing is spilled beyond need.
    expect(remaining + (selected.spill.at(-1)?.bytes ?? 0)).toBeGreaterThan(TOOL_RESULT_GROUP_BUDGET_BYTES);
    expect([...selected.decided].sort()).toEqual(
      GROUP_BYTES.map((_, index) => gKey(index, T0 + 2_000 + index)).sort(),
    );
  });

  it('budgets each wire-level group separately — an assistant message between results splits them', () => {
    // Both halves of the same over-budget set, but separated by an assistant turn: pi-ai emits two
    // provider messages, so neither half is over budget on its own and nothing spills.
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      groupResult(0, T0 + 2_000), groupResult(1, T0 + 3_000), groupResult(2, T0 + 4_000),
      assistant('calling again', T0 + 5_000),
      groupResult(3, T0 + 6_000), groupResult(4, T0 + 7_000), groupResult(5, T0 + 8_000),
    ];
    expect(selectBudgetedToolResults(messages, new Set(), new Set()).spill).toEqual([]);
  });

  it('ignores history: only the current run is eligible, whatever older groups weigh', () => {
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      ...GROUP_BYTES.map((_, index) => groupResult(index, T0 + 2_000 + index)),
      user('two', T0 + 9_000),
    ];
    expect(selectBudgetedToolResults(messages, new Set(), new Set())).toEqual({ spill: [], decided: [] });
  });

  it('counts a member without a toolCallId toward the group but can never spill it', () => {
    const anonymous = {
      role: 'toolResult', toolCallId: '', toolName: 'Bash', isError: false, timestamp: T0 + 2_000,
      content: [{ type: 'text', text: 'n'.repeat(GROUP_BYTES[0]) }],
    } as PiAgentMessage;
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000), anonymous,
      groupResult(1, T0 + 3_000), groupResult(2, T0 + 4_000), groupResult(3, T0 + 5_000), groupResult(4, T0 + 6_000),
    ];
    const selected = selectBudgetedToolResults(messages, new Set(), new Set());
    // 49k + 48k + 47k + 46k + 45k = 235k: over budget, and the 49k anonymous member is what pushes it
    // there — yet the spill has to come out of the members that actually have a spill path.
    expect(selected.spill.map((item) => item.toolCallId)).toEqual(['g-1']);
    expect(selected.decided).not.toContain('');
  });

  it('charges nothing for an already-spilled member', () => {
    // g-0 spilled by the per-result layer: the group now costs 201k, one member over budget.
    const selected = selectBudgetedToolResults(overBudgetTurn(), new Set([gKey(0, T0 + 2_000)]), new Set());
    expect(selected.spill.map((item) => item.toolCallId)).toEqual(['g-1']);
    expect(selected.decided).not.toContain(gKey(0, T0 + 2_000));
  });

  it('counts a decided member at full size but never spills it again', () => {
    // g-0 is the largest and would be the first pick, but it has already been ruled on — it went to the
    // provider whole, so the spilling has to come out of the members below it instead.
    const selected = selectBudgetedToolResults(overBudgetTurn(), new Set(), new Set([gKey(0, T0 + 2_000)]));
    expect(selected.spill.map((item) => item.toolCallId)).toEqual(['g-1', 'g-2']);
    expect(selected.decided).not.toContain(gKey(0, T0 + 2_000));
  });
});

describe('the aggregate budget comes from configuration, not from the constant', () => {
  // Module state: a leaked override would retune every later test in this file.
  afterEach(() => setToolResultGroupBudget(() => TOOL_RESULT_GROUP_BUDGET_BYTES));

  it('re-reads the budget on every pass, so a Limits change applies without a respawn', () => {
    // 46k + 45k + 15k = 106k: comfortably under the default budget, nothing to do.
    const modest: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      groupResult(3, T0 + 2_000), groupResult(4, T0 + 3_000), groupResult(5, T0 + 4_000),
    ];
    expect(selectBudgetedToolResults(modest, new Set(), new Set()).spill).toEqual([]);

    let budget = 100_000;
    setToolResultGroupBudget(() => budget);
    // Same messages, tighter budget: the largest member goes out. A budget captured anywhere but here
    // would leave this empty.
    expect(selectBudgetedToolResults(modest, new Set(), new Set()).spill.map((item) => item.toolCallId))
      .toEqual(['g-3']);

    // And back: the knob moves both ways within one process, which a compile-time constant cannot.
    budget = 500_000;
    expect(selectBudgetedToolResults(overBudgetTurn(), new Set(), new Set()).spill).toEqual([]);
  });

  it('never applies a budget below the per-result threshold in force', () => {
    // A group of ONE 46k result: the per-result layer deliberately keeps it inline (its threshold is
    // 50k), so no aggregate setting may spill it merely for being alone in its group.
    const single: PiAgentMessage[] = [user('one', T0), assistant('calling', T0 + 1_000), groupResult(3, T0 + 2_000)];
    setToolResultGroupBudget(() => 1_000);
    expect(selectBudgetedToolResults(single, new Set(), new Set()).spill).toEqual([]);
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

  it('leaves a fresh result under the size trigger completely alone', async () => {
    const h = harness();
    const underBy1 = 'z'.repeat(SPILL_MAX_RESULT_BYTES);
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      toolResult('fresh-big', big, T0 + 2_000), toolResult('fresh-at-limit', underBy1, T0 + 3_000),
    ];
    const result = await h.transform(messages);
    expect(result).toBe(messages);
    expect(h.writes.size).toBe(0);
  });

  it('spills an oversized fresh result on delivery, with a path and a bounded preview', async () => {
    const h = harness();
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000), toolResult('fresh', oversized, T0 + 2_000),
    ];
    // No idle gap anywhere: the size trigger fires regardless of the cache gate.
    const result = await h.transform(messages);
    const path = spillPath(h, 'fresh');
    expect(h.writes.get(path)).toBe(oversized); // the FULL text reaches disk, tail included
    const text = (result[2] as { content: { type: string; text?: string }[] }).content[0]?.text ?? '';
    expect(text).toBe(clearedToolResultPlaceholder(path, oversized.length, oversized.slice(0, SPILL_PREVIEW_CHARS)));
    expect(text).toContain(path);
    expect(text).toContain('HEAD-zzz'); // the preview is really the head of the content
    expect(text).not.toContain('-TAIL'); // …and it is bounded: the end only exists on disk
    expect(text.length).toBeLessThan(SPILL_PREVIEW_CHARS + 500);
    expect(result[0]).toBe(messages[0]); // nothing else in the turn is touched
    expect(result[1]).toBe(messages[1]);
  });

  it('a size-spilled result stays spilled with byte-identical placeholder bytes', async () => {
    const h = harness();
    const turn1: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000), toolResult('fresh', oversized, T0 + 2_000),
    ];
    const first = await h.transform(turn1);
    const turn2: PiAgentMessage[] = [...turn1, assistant('done', T0 + 3_000), user('two', T0 + 4_000)];
    const second = await h.transform(turn2);
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(h.writes.size).toBe(1); // latched: no second write, no second spill file
  });

  it('leaves a whole group of medium results in place while it fits the budget', async () => {
    const h = harness();
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      groupResult(3, T0 + 2_000), groupResult(4, T0 + 3_000), groupResult(5, T0 + 4_000),
    ];
    const result = await h.transform(messages);
    expect(result).toBe(messages);
    expect(h.writes.size).toBe(0);
  });

  it('spills the largest members of an over-budget group, with the same preview placeholder', async () => {
    const h = harness();
    const messages = overBudgetTurn();
    const result = await h.transform(messages);

    const expectedIds = ['g-0', 'g-1'];
    expect(spilledIds(h)).toEqual(expectedIds);
    for (const [offset, id] of expectedIds.entries()) {
      const path = spillPath(h, id);
      const original = (messages[2 + offset] as { content: { text: string }[] }).content[0].text;
      expect(h.writes.get(path)).toBe(original); // the full text reaches disk, recoverable with Read
      const text = (result[2 + offset] as { content: { type: string; text?: string }[] }).content[0]?.text ?? '';
      expect(text).toBe(clearedToolResultPlaceholder(path, original.length, original.slice(0, SPILL_PREVIEW_CHARS)));
    }
    // The smaller members keep their identity, and what is left really is under budget.
    for (let index = 4; index < messages.length; index += 1) expect(result[index]).toBe(messages[index]);
    const inline = result.slice(2).reduce(
      (sum, message) => sum + Buffer.byteLength((message as { content: { text?: string }[] }).content[0]?.text ?? '', 'utf8'),
      0,
    );
    expect(inline).toBeLessThanOrEqual(TOOL_RESULT_GROUP_BUDGET_BYTES);
  });

  it('a single oversized result stays the per-result path\'s business, and the budget layer then fits', async () => {
    const h = harness();
    // One result over the per-result trigger next to two ordinary ones: spilling that one alone already
    // brings the group under budget, so the aggregate layer must not touch the others.
    const messages: PiAgentMessage[] = [
      user('one', T0), assistant('calling', T0 + 1_000),
      toolResult('fresh', oversized, T0 + 2_000), groupResult(3, T0 + 3_000), groupResult(4, T0 + 4_000),
    ];
    const result = await h.transform(messages);
    expect([...h.writes.keys()]).toEqual([spillPath(h, 'fresh')]);
    expect(result[3]).toBe(messages[3]);
    expect(result[4]).toBe(messages[4]);
  });

  it('idempotence: repeated passes over the same and the grown history are byte-identical', async () => {
    const h = harness();
    const turn = overBudgetTurn();
    const first = await h.transform(turn);
    const serialized = JSON.stringify(first);
    // Same history again — the decisions are latched, so not one byte of the prefix may move. A pass
    // that re-measured the group (counting an already-spilled member at its original size) would keep
    // spilling members here and drift.
    expect(JSON.stringify(await h.transform(turn))).toBe(serialized);
    expect(JSON.stringify(await h.transform(turn))).toBe(serialized);
    expect(h.writes.size).toBe(2); // latched: no second spill file either
    // …and the same holds once the conversation moves on and the group scrolls into history.
    const next: PiAgentMessage[] = [...turn, assistant('done', T0 + 9_000), user('two', T0 + 10_000)];
    const grown = await h.transform(next);
    expect(JSON.stringify(grown.slice(0, first.length))).toBe(serialized);
  });

  it('idempotence: a member already handed over whole is never re-judged when its group grows', async () => {
    // The transform seam promises nothing about a group being complete the first time it is seen, and
    // the budget of a partial group is not the budget of the finished one. What makes that harmless is
    // the latch: whatever went out whole on an earlier pass stays whole, and the spilling comes out of
    // the members the provider has not seen yet.
    const h = harness();
    const full = overBudgetTurn();
    const partial = full.slice(0, 5); // user, assistant, g-0, g-1, g-2 — 144k, comfortably under budget
    const first = await h.transform(partial);
    expect(first).toBe(partial);
    expect(h.writes.size).toBe(0);

    const second = await h.transform(full);
    expect(JSON.stringify(second.slice(0, partial.length))).toBe(JSON.stringify(partial));
    expect(spilledIds(h)).toEqual(['g-3', 'g-4']);
  });

  it('idempotence: a failed spill never cascades to a different member on a later pass', async () => {
    // Only the largest member fails to spill. Its group therefore stays over budget — but every member
    // of it has already gone to the provider whole, so a second pass must NOT pick a new victim.
    const writes = new Map<string, string>();
    const h = harness({
      writeSpill: async (path, text) => {
        // Matched by prefix: the rest of the name carries the byte count, which this test has no reason
        // to know.
        if (path.startsWith('/tmp/spill/sess-1/g-0.v1-')) throw Object.assign(new Error('readonly'), { code: 'EACCES' });
        writes.set(path, text);
      },
    });
    const turn = overBudgetTurn();
    const first = await h.transform(turn);
    expect(JSON.stringify(first[2])).toContain('aaaa'); // g-0 still full: its spill failed
    expect(writes.size).toBe(1); // only g-1 made it to disk
    const serialized = JSON.stringify(first);
    expect(JSON.stringify(await h.transform(turn))).toBe(serialized);
    expect(writes.size).toBe(1);
  });

  it('spills into the real namespace dir, and the existing session cleanup removes it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-size-spill-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    try {
      // Production wiring end to end: the store mints the conversation's immutable spill namespace, the
      // resolver (exactly what buildBrainCore installs) hands it to the module's default spill dir, and
      // the store's delete sweeps the SAME directory — so re-keying the session id can never separate
      // the files from the conversation that owns them.
      const store = new BrainStore(openDb(':memory:'));
      store.createSession({ id: 'sess-fs', userId: 7, model: 'm' });
      setSpillNamespaceResolver((id) => store.spillNamespace(id));
      const session: Harness['session'] = { agent: {} };
      installToolResultClearing(session, 'sess-fs', { idleMs: IDLE });
      const messages: PiAgentMessage[] = [user('one', T0), toolResult('fresh', oversized, T0 + 1_000)];
      const result = await session.agent.transformContext!(messages);
      const text = (result[1] as { content: { type: string; text?: string }[] }).content[0]?.text ?? '';
      const spilled = /Full output at: (\S+) — read it/.exec(text)?.[1];
      expect(spilled).toBe(join(toolResultSpillDir(process.env, store.spillNamespace('sess-fs')), `fresh.v1-preview-${Buffer.byteLength(oversized, 'utf8')}.txt`));
      expect(readFileSync(spilled!, 'utf8')).toBe(oversized);

      store.deleteSession('sess-fs');
      expect(existsSync(spilled!)).toBe(false);
    } finally {
      setSpillNamespaceResolver(undefined);
      vi.unstubAllEnvs();
    }
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

  // Emoji straddling the preview boundary: slice() cuts by UTF-16 unit, so the preview can end on half a
  // surrogate pair. If that string did not survive the write/read round-trip the restored placeholder
  // would differ by bytes — which is the whole failure this feature exists to prevent.
  const previewBoundaryText = `${'p'.repeat(SPILL_PREVIEW_CHARS - 1)}😀${'q'.repeat(SPILL_MAX_RESULT_BYTES)}`;

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
    toolResult('fresh-huge', previewBoundaryText, T0 + IDLE + 5_000),
  ];

  it('re-sends byte-identical placeholders after a restart, for both triggers', async () => {
    const disk = new Map<string, string>();
    const before = await restartOver(disk)(history());
    const timeText = (before[1] as { content: { text: string }[] }).content[0]!.text;
    const multiText = (before[2] as { content: { text: string }[] }).content[0]!.text;
    const previewText = (before[6] as { content: { text: string }[] }).content[0]!.text;
    expect(timeText).toContain('Older tool result cleared');
    expect(previewText).toContain('saved to disk instead of the context');
    // The multi-block result's own placeholder must quote the summed BLOCK bytes, not the file size.
    expect(multiText).toContain(`${big.length * 3} bytes`);

    const after = await restartOver(disk)(history());
    // Exact string equality on purpose: "contains a placeholder" would pass even if the byte count or the
    // path differed, and a single differing byte is a full re-cache of the whole conversation.
    expect((after[1] as { content: { text: string }[] }).content[0]!.text).toBe(timeText);
    expect((after[2] as { content: { text: string }[] }).content[0]!.text).toBe(multiText);
    expect((after[6] as { content: { text: string }[] }).content[0]!.text).toBe(previewText);
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
  const liveTurn: PiAgentMessage[] = [user('one', T0), assistant('calling', T0 + 1_000), liveImageResult];
  /** The same result as `rehydrate` replays it after a crash: persistence externalized the image and
   *  `withoutExternalizedImages` replaced it with the placeholder TEXT block — the text of the very
   *  same result now differs from what was spilled. The new prompt lands after the settled history. */
  const rehydratedTurn = (promptAt: number): PiAgentMessage[] => [
    user('one', T0), assistant('calling', T0 + 1_000),
    {
      ...liveImageResult,
      content: [{ type: 'text', text: HISTORY_IMAGE_PLACEHOLDER }, { type: 'text', text: oversized }],
    } as PiAgentMessage,
    user('two', promptAt),
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
    expect(placeholder).toContain('saved to disk instead of the context');
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
    const { path, bytes } = await persistToolOutputSpill(dir, 'call-1', text);

    expect(path).toBe(join(dir, 'call-1.v1-output-10000.txt'));
    expect(bytes).toBe(10_000);
    expect(readFileSync(path, 'utf8')).toBe(text);
  });

  it('fs-encodes the toolCallId so a hostile id cannot escape the spill dir', async () => {
    const dir = spillDir();
    const { path } = await persistToolOutputSpill(dir, '../escape', 'x');
    expect(path).toBe(join(dir, '..%2Fescape.v1-output-1.txt'));
  });

  // A persisted full output is NOT the spill of the result the model received (that result carries an
  // excerpt), so restoreLatch must never offer it as a latch candidate for that toolCallId — it would
  // compare unequal, log a "no spill matches" warning and, if it ever did match, describe the result with
  // the wrong byte count.
  it('is named outside the latch descriptor grammar', async () => {
    const dir = spillDir();
    const { path } = await persistToolOutputSpill(dir, 'c', 'hello');
    expect(parseSpillDescriptor(path.slice(path.lastIndexOf('/') + 1), 'c')).toBeNull();
  });

  // Same id AND same size is only reachable through a reused sequential toolCallId; refusing the write
  // would cost the caller its "saved to" note to protect a file that is almost certainly identical.
  it('overwrites its own earlier file rather than failing the caller', async () => {
    const dir = spillDir();
    const first = await persistToolOutputSpill(dir, 'call-1', 'aaaaa');
    const second = await persistToolOutputSpill(dir, 'call-1', 'bbbbb');
    expect(second.path).toBe(first.path);
    expect(readFileSync(second.path, 'utf8')).toBe('bbbbb');
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
