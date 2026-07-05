import { describe, it, expect } from 'vitest';
import { stripInlineReasoning, extractText } from '../../src/brain/messageView.js';

describe('stripInlineReasoning', () => {
  it('leaves text without reasoning tags untouched', () => {
    expect(stripInlineReasoning('just a normal answer')).toBe('just a normal answer');
  });

  it('removes a complete <think>…</think> block, keeping the answer', () => {
    expect(stripInlineReasoning('<think>let me reason\nabout this</think>\n\nThe answer is 42.')).toBe('The answer is 42.');
    expect(stripInlineReasoning('<thinking>hmm</thinking>Hello')).toBe('Hello');
  });

  it('removes an unclosed trailing reasoning block (stream cut off before the answer)', () => {
    expect(stripInlineReasoning('<think>still reasoning and never closed')).toBe('');
  });

  it('drops reasoning that streamed before a lone closing tag', () => {
    expect(stripInlineReasoning('reasoning with no open tag</think>\n\nFinal answer.')).toBe('Final answer.');
  });

  it('handles multiple blocks and preserves interleaved answer text', () => {
    expect(stripInlineReasoning('<think>a</think>one<think>b</think>two')).toBe('onetwo');
  });
});

describe('extractText strips leaked reasoning', () => {
  it('sanitizes an array-content assistant message', () => {
    const msg = { content: [{ type: 'text', text: '<think>secret</think>visible' }] };
    expect(extractText(msg)).toBe('visible');
  });
  it('sanitizes a string-content message', () => {
    expect(extractText({ content: '<think>x</think>ok' })).toBe('ok');
  });
});
