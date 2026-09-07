import { describe, it, expect } from 'vitest';
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
  FORK_PLACEHOLDER_RESULT,
  buildForkBoundaryMessages,
  buildForkChildMessage,
  buildForkWorktreeNotice,
  forkCacheVerdict,
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

describe('fork boundary messages', () => {
  it('answers EVERY tool call of the parent assistant with the same placeholder', () => {
    const assistant = parentAssistant(toolCall('a', 'Delegate'), toolCall('b', 'Read'));
    const built = buildForkBoundaryMessages('audit the store', assistant, 1_700_000_000_000);

    expect(built).toHaveLength(4);
    expect(built[0]).toBe(assistant); // the parent's message, whole and unmodified
    expect(built.slice(1, 3).map((m) => m.role)).toEqual(['toolResult', 'toolResult']);
    expect(built.slice(1, 3).map((m) => m.toolCallId)).toEqual(['a', 'b']);
    const texts = built.slice(1, 3).map((m) => (m.content as { text: string }[])[0]!.text);
    expect(texts).toEqual([FORK_PLACEHOLDER_RESULT, FORK_PLACEHOLDER_RESULT]);
  });

  it('puts the directive last, behind the constant boilerplate', () => {
    const built = buildForkBoundaryMessages('audit the store', parentAssistant(toolCall('a', 'Delegate')), 1);
    const last = built.at(-1)!;

    expect(last.role).toBe('user');
    expect(last.content).toBe(buildForkChildMessage('audit the store'));
    expect(String(last.content)).toContain(`${FORK_DIRECTIVE_PREFIX}audit the store`);
    expect(String(last.content).indexOf(`</${FORK_BOILERPLATE_TAG}>`))
      .toBeLessThan(String(last.content).indexOf(FORK_DIRECTIVE_PREFIX));
  });

  it('gives two children of one parent turn an identical prefix and only a different directive', () => {
    const assistant = parentAssistant(toolCall('a', 'Delegate'), toolCall('b', 'Delegate'));
    const first = buildForkBoundaryMessages('first job', assistant, 7);
    const second = buildForkBoundaryMessages('second job', assistant, 7);

    expect(JSON.stringify(first.slice(0, -1))).toBe(JSON.stringify(second.slice(0, -1)));
    expect(first.at(-1)!.content).not.toBe(second.at(-1)!.content);
  });

  it('still delivers the directive when the parent assistant carries no tool call', () => {
    const built = buildForkBoundaryMessages('orphan', { role: 'assistant', content: [] }, 1);
    expect(built).toHaveLength(1);
    expect(built[0]!.role).toBe('user');
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
