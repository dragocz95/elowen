import { describe, it, expect } from 'vitest';
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
  FORK_PLACEHOLDER_RESULT,
  buildForkChildMessage,
  buildForkWorktreeNotice,
  forkCacheVerdict,
  forkSeedMessages,
  formatForkCacheLine,
  isInForkChild,
  type ForkCacheReading,
  type ForkMessage,
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

describe('isInForkChild', () => {
  it('detects the boilerplate in a plain-string user message', () => {
    expect(isInForkChild([{ role: 'user', content: buildForkChildMessage('x') }])).toBe(true);
  });

  it('detects it in a block-shaped user message', () => {
    const message: ForkMessage = { role: 'user', content: [{ type: 'text', text: buildForkChildMessage('x') }] };
    expect(isInForkChild([message])).toBe(true);
  });

  it('does not fire on an ordinary conversation, or on the tag inside an assistant message', () => {
    expect(isInForkChild([{ role: 'user', content: 'please fork the repo' }])).toBe(false);
    expect(isInForkChild([{ role: 'assistant', content: [{ type: 'text', text: `<${FORK_BOILERPLATE_TAG}>` }] }]))
      .toBe(false);
  });
});

describe('buildForkWorktreeNotice', () => {
  it('names both directories so the child can translate inherited paths', () => {
    const notice = buildForkWorktreeNotice('/srv/app', '/srv/wt/agent-1');
    expect(notice).toContain('/srv/app');
    expect(notice).toContain('/srv/wt/agent-1');
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
});

describe('formatForkCacheLine', () => {
  it('renders the shared case with every counter the verdict rests on', () => {
    expect(formatForkCacheLine(reading())).toBe(
      'fork brain-ch-subagent-sub-dlg-1 from brain-7: cacheRead=98000 cacheWrite=400 input=120 '
      + 'parentPrefix≈100000 verdict=shared (parent prefix reused)',
    );
  });

  it('renders the not-shared case and names what broke it', () => {
    expect(formatForkCacheLine(reading({ sameModel: false, cacheRead: 0, cacheWrite: 100_000 }))).toBe(
      'fork brain-ch-subagent-sub-dlg-1 from brain-7: cacheRead=0 cacheWrite=100000 input=120 '
      + 'parentPrefix≈100000 verdict=not-shared (different model)',
    );
  });
});
