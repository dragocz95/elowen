import { describe, it, expect } from 'vitest';
import {
  FORK_BOILERPLATE_TAG,
  FORK_CHILD_RESERVE_TOKENS,
  FORK_DIRECTIVE_PREFIX,
  FORK_PLACEHOLDER_RESULT,
  buildForkChildMessage,
  forkCacheVerdict,
  forkExceedsChildWindow,
  forkParentPrefixTokens,
  forkSeedMessages,
  forkWindowRefusal,
  formatForkCacheLine,
  type ForkCacheReading,
  type ForkMessage,
  type ForkWindowFit,
} from '../../../src/brain/session/forkPrefix.js';

const toolCall = (id: string, name: string) => ({ type: 'toolCall', id, name, arguments: {} });

const parentAssistant = (...calls: ReturnType<typeof toolCall>[]): ForkMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'working on it' }, ...calls],
  stopReason: 'toolUse',
});

const history: ForkMessage[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
];

describe('fork seed messages', () => {
  it('keeps the parent history verbatim and answers every unanswered tool call alike', () => {
    const assistant = parentAssistant(toolCall('a', 'Delegate'), toolCall('b', 'Read'));
    const seed = forkSeedMessages([...history, assistant], 1_700_000_000_000);

    expect(seed).toHaveLength(5);
    expect(seed.slice(0, 3)).toEqual([...history, assistant]);
    expect(seed.slice(3).map((m) => m.role)).toEqual(['toolResult', 'toolResult']);
    expect(seed.slice(3).map((m) => m.toolCallId)).toEqual(['a', 'b']);
    const texts = seed.slice(3).map((m) => (m.content as { text: string }[])[0]!.text);
    expect(texts).toEqual([FORK_PLACEHOLDER_RESULT, FORK_PLACEHOLDER_RESULT]);
  });

  it('leaves an already-answered tool call alone', () => {
    const assistant = parentAssistant(toolCall('a', 'Read'));
    const answered: ForkMessage = { role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] };
    const seed = forkSeedMessages([...history, assistant, answered], 1);
    expect(seed).toEqual([...history, assistant, answered]);
  });

  it('gives two children of one parent turn a byte-identical seed', () => {
    const assistant = parentAssistant(toolCall('a', 'Delegate'), toolCall('b', 'Delegate'));
    const first = forkSeedMessages([...history, assistant], 7);
    const second = forkSeedMessages([...history, assistant], 7);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('returns a settled history untouched', () => {
    expect(forkSeedMessages(history, 1)).toEqual(history);
  });
});

describe('the fork directive prompt', () => {
  it('puts the directive behind the constant boilerplate', () => {
    const text = buildForkChildMessage('audit the store');
    expect(text).toContain(`${FORK_DIRECTIVE_PREFIX}audit the store`);
    expect(text.indexOf(`</${FORK_BOILERPLATE_TAG}>`)).toBeLessThan(text.indexOf(FORK_DIRECTIVE_PREFIX));
  });

  it('differs between two children only after the boilerplate', () => {
    const first = buildForkChildMessage('first job');
    const second = buildForkChildMessage('second job');
    const shared = `</${FORK_BOILERPLATE_TAG}>`;
    expect(first.slice(0, first.indexOf(shared))).toBe(second.slice(0, second.indexOf(shared)));
    expect(first).not.toBe(second);
  });
});

const reading = (over: Partial<ForkCacheReading> = {}): ForkCacheReading => ({
  childSessionId: 'brain-ch-subagent-sub-dlg-1',
  parentSessionId: 'brain-7',
  cacheRead: 98_000,
  cacheWrite: 400,
  input: 120,
  parentPrefix: 100_000,
  sameModel: true,
  providerCaches: true,
  ...over,
});

describe('fork cache verdict', () => {
  it('calls a fork shared when it read nearly the whole parent prefix and wrote little', () => {
    expect(forkCacheVerdict(reading())).toEqual({ shared: true, reason: 'parent prefix reused' });
  });

  it('accepts a read exactly at the 90% threshold', () => {
    expect(forkCacheVerdict(reading({ cacheRead: 90_000, cacheWrite: 0 })).shared).toBe(true);
  });

  it('blames the model before anything else', () => {
    expect(forkCacheVerdict(reading({ sameModel: false, cacheRead: 0, cacheWrite: 100_000 })))
      .toEqual({ shared: false, reason: 'different model' });
  });

  it('blames a provider that reports no cache accounting', () => {
    expect(forkCacheVerdict(reading({ providerCaches: false, cacheRead: 0 })))
      .toEqual({ shared: false, reason: 'provider without cache' });
  });

  it('reports a prefix mismatch when the read falls short', () => {
    expect(forkCacheVerdict(reading({ cacheRead: 40_000 })))
      .toEqual({ shared: false, reason: 'prefix mismatch' });
  });

  it('refuses to call a large rewrite shared even when the read looks high', () => {
    expect(forkCacheVerdict(reading({ cacheRead: 95_000, cacheWrite: 60_000 })))
      .toEqual({ shared: false, reason: 'prefix rewritten' });
  });

  it('does not claim sharing when the parent prefix is unknown', () => {
    expect(forkCacheVerdict(reading({ parentPrefix: 0 })))
      .toEqual({ shared: false, reason: 'parent prefix unknown' });
  });

  it('blames a failed first request before anything the counters could suggest', () => {
    // A fork whose first request 400s reads nothing, so every counter is zero — and "prefix mismatch"
    // would be a true statement about a number that describes none of what happened.
    expect(forkCacheVerdict(reading({
      cacheRead: 0,
      failure: "first request failed: Tool reference 'WorkflowStart' not found in available tools",
    }))).toEqual({
      shared: false,
      reason: "first request failed: Tool reference 'WorkflowStart' not found in available tools",
    });
  });
});

describe('the fork size guard', () => {
  const fit = (over: Partial<ForkWindowFit> = {}): ForkWindowFit => ({
    seedTokens: 100_000,
    parentModel: 'anthropic/big',
    parentWindow: 1_000_000,
    childModel: 'anthropic/small',
    childWindow: 200_000,
    ...over,
  });

  it('admits a seed that leaves the child room to answer', () => {
    expect(forkExceedsChildWindow(fit())).toBe(false);
  });

  it('refuses a parent conversation that outgrew the CHILD’s window', () => {
    // The production failure: a ~480k-token owner chat forked onto a 200k-window model. Nothing rejected
    // it, so the oversized request went to the transport and came back as a bare connection error.
    expect(forkExceedsChildWindow(fit({ seedTokens: 480_000 }))).toBe(true);
  });

  it('refuses a seed that fits only by leaving the child no room of its own', () => {
    expect(forkExceedsChildWindow(fit({ seedTokens: 200_000 - FORK_CHILD_RESERVE_TOKENS + 1 }))).toBe(true);
    expect(forkExceedsChildWindow(fit({ seedTokens: 200_000 - FORK_CHILD_RESERVE_TOKENS }))).toBe(false);
  });

  it('abstains when the child window is unknown rather than refusing on a guess', () => {
    expect(forkExceedsChildWindow(fit({ seedTokens: 5_000_000, childWindow: 0 }))).toBe(false);
  });

  it('names both models, both windows and the way out', () => {
    const message = forkWindowRefusal(fit({ seedTokens: 480_000 }));
    expect(message).toContain('480000');
    expect(message).toContain('anthropic/small');
    expect(message).toContain('200000');
    expect(message).toContain('anthropic/big');
    expect(message).toContain('1000000');
    // The instance default turns an omitted `fork` into a fork, so the caller has to be told the one
    // word that gets their delegation to run at all.
    expect(message).toContain('`fork: false`');
  });

  it('says the parent window is unknown instead of printing a zero', () => {
    expect(forkWindowRefusal(fit({ parentWindow: 0 }))).toContain('context window unknown');
  });
});

describe('formatForkCacheLine', () => {
  it('renders the shared case with every counter the verdict rests on', () => {
    expect(formatForkCacheLine(reading())).toBe(
      'fork brain-ch-subagent-sub-dlg-1 from brain-7: cacheRead=98000 cacheWrite=400 input=120 '
      + 'parentPrefix≈100000 verdict=shared (parent prefix reused)',
    );
  });

  it('reports a fork whose first request failed, with the failure as the reason', () => {
    // Both production failures produced NO line at all, because the reporter abstained on an error
    // message — so the one evidence surface for forking was silent exactly when it mattered.
    expect(formatForkCacheLine(reading({
      cacheRead: 0, cacheWrite: 0, input: 0, failure: 'first request failed: Connection error.',
    }))).toBe(
      'fork brain-ch-subagent-sub-dlg-1 from brain-7: cacheRead=0 cacheWrite=0 input=0 '
      + 'parentPrefix≈100000 verdict=not-shared (first request failed: Connection error.)',
    );
  });

  it('renders the not-shared case and names what broke it', () => {
    expect(formatForkCacheLine(reading({ sameModel: false, cacheRead: 0, cacheWrite: 100_000 }))).toBe(
      'fork brain-ch-subagent-sub-dlg-1 from brain-7: cacheRead=0 cacheWrite=100000 input=120 '
      + 'parentPrefix≈100000 verdict=not-shared (different model)',
    );
  });
});

describe('forkParentPrefixTokens', () => {
  it('reads the parent’s LAST usage, since the fork inherits the whole conversation', () => {
    expect(forkParentPrefixTokens([
      { role: 'assistant', usage: { cacheRead: 10, input: 5 } },
      { role: 'user', content: 'more' },
      { role: 'assistant', usage: { cacheRead: 90_000, input: 400 } },
    ])).toBe(90_400);
  });

  it('reports 0 rather than a guess when the parent has produced no usage', () => {
    expect(forkParentPrefixTokens([{ role: 'user', content: 'hi' }])).toBe(0);
    expect(forkParentPrefixTokens([{ role: 'assistant', content: [] }])).toBe(0);
  });
});
