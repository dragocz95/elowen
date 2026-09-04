import { describe, it, expect } from 'vitest';
import { finishedAnswerOf } from '../../src/brain/service/delegatedSession.js';

/** Row shapes as the per-message mirror writes them (anonymized from the 4 Sep production DB). Only the
 *  first one is a finished child; every other tail must be RESPAWNED, never completed from the transcript. */
const usage = { input: 1719, output: 214, cacheRead: 51072, cacheWrite: 0, reasoning: 42, totalTokens: 53005, cost: { total: 0.04 } };
const row = (m: object) => JSON.stringify(m);

describe('finishedAnswerOf — a child completes from its transcript only on a provably final message', () => {
  it('accepts a text-only assistant closed with stopReason stop and usage stamped', () => {
    expect(finishedAnswerOf([row({ role: 'assistant', content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'FINAL: done.' }], stopReason: 'stop', usage })]))
      .toBe('FINAL: done.');
  });

  it.each([
    ['a partially streamed text without stopReason', { role: 'assistant', content: [{ type: 'text', text: 'I will now run the tests and' }] }],
    ['a stop without usage (final chunk never arrived)', { role: 'assistant', content: [{ type: 'text', text: 'Looks finished' }], stopReason: 'stop' }],
    ['usage without both token counts', { role: 'assistant', content: [{ type: 'text', text: 'Looks finished' }], stopReason: 'stop', usage: { input: 5 } }],
    ['a narrative before the next tool call (toolUse)', { role: 'assistant', content: [{ type: 'text', text: 'Now fixing it.' }, { type: 'toolCall', id: 't1', name: 'Bash', arguments: {} }], stopReason: 'toolUse', usage }],
    ['a length cut', { role: 'assistant', content: [{ type: 'text', text: 'long …' }], stopReason: 'length', usage }],
    ['an abort (orphaned runner)', { role: 'assistant', content: [{ type: 'text', text: 'half' }], stopReason: 'aborted', usage }],
    ['an error', { role: 'assistant', content: [], stopReason: 'error', usage }],
    ['an empty final', { role: 'assistant', content: [{ type: 'text', text: '  ' }], stopReason: 'stop', usage }],
    ['a tool result tail', { role: 'toolResult', toolCallId: 't1', toolName: 'Bash', content: [{ type: 'text', text: '[exit 0]' }] }],
  ])('refuses %s', (_label, message) => {
    expect(finishedAnswerOf([row(message)])).toBeUndefined();
  });

  it('reads only the LAST row and tolerates a corrupt one', () => {
    expect(finishedAnswerOf([row({ role: 'assistant', content: [{ type: 'text', text: 'earlier' }], stopReason: 'stop', usage }), '{corrupt'])).toBeUndefined();
    expect(finishedAnswerOf([])).toBeUndefined();
  });
});
