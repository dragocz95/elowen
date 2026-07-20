import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { splitContent, extractImageRefs, stripThinking, parseModelExec, stripForSpeech } from '../../plugins/_shared/format.mjs';

describe('shared plugin format helpers', () => {
  it('splitContent / extractImageRefs / stripThinking never throw on a null or undefined body (the shipped Discord/WhatsApp TypeError)', () => {
    expect(() => splitContent(null, 1990)).not.toThrow();
    expect(splitContent(undefined, 1990)).toEqual(['']);
    expect(() => extractImageRefs(undefined)).not.toThrow();
    expect(extractImageRefs(null)).toEqual({ cleaned: '', files: [] });
    expect(stripThinking(undefined)).toBe('');
  });

  it('splitContent keeps a fenced code block intact across a chunk boundary', () => {
    const body = 'before\n```js\n' + 'x'.repeat(50) + '\n```\nafter';
    const pieces = splitContent(body, 40);
    expect(pieces.length).toBeGreaterThan(1);
    // Every piece has balanced fences (the split reopens the block).
    for (const p of pieces) expect((p.match(/```/g)?.length ?? 0) % 2).toBe(0);
    // Every code character survives the split (the reopen/close fences are injected around them).
    expect((pieces.join('').match(/x/g) ?? []).length).toBe(50);
  });

  it('extractImageRefs pulls brain-image links and leaves other text, guarding path tricks', () => {
    const { cleaned, files } = extractImageRefs('see ![a](http://x/brain/images/abc123.png) and ![b](/brain/images/def.png)');
    expect(files).toEqual(['abc123.png', 'def.png']);
    expect(cleaned).not.toContain('brain/images');
    // A non-matching name (uppercase / path segment) is left untouched.
    expect(extractImageRefs('![x](/brain/images/../evil.png)').files).toEqual([]);
  });

  it('stripThinking removes inline chain-of-thought; parseModelExec parses the three exec shapes', () => {
    expect(stripThinking('<think>secret</think>answer')).toBe('answer');
    expect(parseModelExec('elowen:anthropic/claude-x')).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(parseModelExec('anthropic/claude-x')).toEqual({ provider: 'anthropic', model: 'claude-x' });
    expect(parseModelExec('claude-x')).toEqual({ model: 'claude-x' });
    expect(parseModelExec('')).toBeNull();
  });

  it('stripForSpeech flattens markdown to speakable prose', () => {
    expect(stripForSpeech('# Title\n`code` and [link](http://x)')).toBe('Title code and link');
    expect(stripForSpeech(null)).toBe('');
  });
});
