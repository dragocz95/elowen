import { describe, expect, it } from 'vitest';
import {
  approxTokenCount,
  buildCodeModeResultItems,
  formatScriptStatus,
  truncateCodeModeResult,
  truncateMiddleWithTokenBudget,
} from '../../plugins/code-mode/src/protocol/output.js';

describe('token estimation', () => {
  it('rounds up to whole tokens at four bytes each', () => {
    expect(approxTokenCount('')).toBe(0);
    expect(approxTokenCount('abc')).toBe(1);
    expect(approxTokenCount('abcd')).toBe(1);
    expect(approxTokenCount('abcde')).toBe(2);
  });

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    // Four bytes in UTF-8, two UTF-16 units.
    expect(approxTokenCount('😀')).toBe(1);
    expect(approxTokenCount('ěě')).toBe(1);
  });
});

describe('truncateMiddleWithTokenBudget', () => {
  it('keeps the head and the tail', () => {
    const input = '0123456789'.repeat(4);
    expect(truncateMiddleWithTokenBudget(input, 5)).toBe('0123456789…5 tokens truncated…0123456789');
  });

  it('returns short text unchanged', () => {
    expect(truncateMiddleWithTokenBudget('hello', 10)).toBe('hello');
  });

  it('returns only the marker for a zero budget', () => {
    expect(truncateMiddleWithTokenBudget('0123456789', 0)).toBe('…3 tokens truncated…');
  });

  it('never splits a multi-byte character', () => {
    const input = 'é'.repeat(40);
    const truncated = truncateMiddleWithTokenBudget(input, 5);
    expect(truncated).toContain('tokens truncated');
    expect(truncated).not.toContain('\uFFFD');
    expect(Buffer.from(truncated, 'utf8').toString('utf8')).toBe(truncated);
  });
});

describe('truncateCodeModeResult', () => {
  it('joins text items and prefixes the warning when over budget', () => {
    const items = [
      { type: 'text' as const, text: '0123456789'.repeat(2) },
      { type: 'text' as const, text: '0123456789'.repeat(2) },
    ];
    const truncated = truncateCodeModeResult(items, 5);
    expect(truncated).toHaveLength(1);
    const text = truncated[0]!.type === 'text' ? truncated[0]!.text : '';
    expect(text).toBe(
      [
        'Warning: truncated output (original token count: 11)',
        // Two items joined with a newline are two lines in the combined document.
        'Total output lines: 2',
        '',
        '0123456789…6 tokens truncated…0123456789',
      ].join('\n'),
    );
  });

  it('leaves text items untouched when they fit', () => {
    const items = [{ type: 'text' as const, text: 'short' }];
    expect(truncateCodeModeResult(items, 100)).toEqual(items);
  });

  it('passes images through free and bills only text', () => {
    const items = [
      { type: 'image' as const, imageUrl: 'data:image/png;base64,AAAA' },
      { type: 'text' as const, text: '0123456789'.repeat(4) },
    ];
    const truncated = truncateCodeModeResult(items, 5);
    expect(truncated[0]).toEqual(items[0]);
    expect(truncated).toHaveLength(2);
    expect(truncated[1]!.type === 'text' && truncated[1]!.text).toContain('tokens truncated');
  });

  it('drops empty text items and reports fully omitted ones', () => {
    const items = [
      { type: 'image' as const, imageUrl: 'data:image/png;base64,AAAA' },
      { type: 'text' as const, text: '' },
      { type: 'text' as const, text: 'abcd' },
      { type: 'text' as const, text: 'second' },
    ];
    const truncated = truncateCodeModeResult(items, 1);
    const texts = truncated.filter((item) => item.type === 'text').map((item) => (item.type === 'text' ? item.text : ''));
    expect(texts).toEqual(['abcd', '[omitted 1 text items ...]']);
  });
});

describe('result assembly', () => {
  it('formats the four script statuses verbatim', () => {
    expect(formatScriptStatus({ kind: 'yielded', cellId: '7' })).toBe('Script running with cell ID 7');
    expect(formatScriptStatus({ kind: 'terminated' })).toBe('Script terminated');
    expect(formatScriptStatus({ kind: 'completed' })).toBe('Script completed');
    expect(formatScriptStatus({ kind: 'failed' })).toBe('Script failed');
  });

  it('prepends the header with one decimal of wall time', () => {
    const items = buildCodeModeResultItems({
      status: { kind: 'completed' },
      items: [{ type: 'text', text: 'before' }],
      wallTimeMs: 1234,
    });
    expect(items[0]).toEqual({ type: 'text', text: 'Script completed\nWall time 1.2 seconds\nOutput:\n' });
    expect(items[1]).toEqual({ type: 'text', text: 'before' });
  });

  it('appends the error item and marks the script failed', () => {
    const items = buildCodeModeResultItems({
      status: { kind: 'failed' },
      items: [{ type: 'text', text: 'before' }],
      errorText: 'Error: boom\n  at exec_main.mjs:2:1',
      wallTimeMs: 0,
    });
    const texts = items.map((item) => (item.type === 'text' ? item.text : ''));
    expect(texts[0]).toBe('Script failed\nWall time 0.0 seconds\nOutput:\n');
    expect(texts.join('\n')).toContain('Script error:\nError: boom');
  });

  it('keeps the header out of the truncation budget', () => {
    const items = buildCodeModeResultItems({
      status: { kind: 'yielded', cellId: '3' },
      items: [{ type: 'text', text: '0123456789'.repeat(40) }],
      maxOutputTokens: 5,
      wallTimeMs: 100,
    });
    expect(items[0]!.type === 'text' && items[0]!.text).toBe(
      'Script running with cell ID 3\nWall time 0.1 seconds\nOutput:\n',
    );
    expect(items[1]!.type === 'text' && items[1]!.text).toContain('tokens truncated');
  });
});
