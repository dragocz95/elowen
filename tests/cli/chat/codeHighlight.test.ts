import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  ensureLang, highlightBlock, highlightLine, langForFence, langForPath, setCodeHighlightListener, wrapTokens,
} from '../../../src/cli/chat/codeHighlight.js';
import type { CodeToken } from '../../../src/cli/chat/codeHighlight.js';
import { diffBlock, framedDiffBlock } from '../../../src/cli/chat/components.js';

const JS_ROW = '+ 12 const answer = 42 // the answer';

describe('langForPath', () => {
  it('maps common extensions to shiki languages', () => {
    expect(langForPath('/tmp/demo/server.ts')).toBe('typescript');
    expect(langForPath('/tmp/demo/server.mjs')).toBe('javascript');
    expect(langForPath('a/b/c.py')).toBe('python');
    expect(langForPath('compose.yml')).toBe('yaml');
    expect(langForPath('/x/Dockerfile')).toBe('dockerfile');
  });

  it('returns null for missing or unknown extensions', () => {
    expect(langForPath('/tmp/README')).toBeNull();
    expect(langForPath('/tmp/.gitignore')).toBeNull();
    expect(langForPath('/tmp/data.unknownext')).toBeNull();
    expect(langForPath('')).toBeNull();
    expect(langForPath(null)).toBeNull();
  });

  it('reads the last token of a tool detail line', () => {
    expect(langForPath('Edit /tmp/demo/app.tsx')).toBe('tsx');
  });

  it('finds the FIRST known path token, ignoring a trailing parenthetical', () => {
    expect(langForPath('src/app.ts (+5 -2)')).toBe('typescript');
    expect(langForPath('Edit src/app.ts (+5 -2)')).toBe('typescript');
    expect(langForPath('(src/main.py)')).toBe('python');
    expect(langForPath('foo bar server.rs baz')).toBe('rust');
    expect(langForPath('nothing here (+1 -1)')).toBeNull();
  });
});

describe('langForFence', () => {
  it('maps fence names and aliases', () => {
    expect(langForFence('json')).toBe('json');
    expect(langForFence('ts')).toBe('typescript');
    expect(langForFence('py')).toBe('python');
    expect(langForFence('sh')).toBe('bash');
  });

  it('returns null for prose fences', () => {
    expect(langForFence('text')).toBeNull();
    expect(langForFence('')).toBeNull();
    expect(langForFence(undefined)).toBeNull();
  });
});

describe('highlightLine', () => {
  it('returns null before the grammar is loaded', () => {
    // terraform is never loaded inside this test file.
    expect(highlightLine('resource "aws_s3_bucket" "b" {}', 'terraform')).toBeNull();
  });

  it('tokenizes with theme colors once the grammar is loaded', async () => {
    await ensureLang('javascript');
    const tokens = highlightLine('const answer = 42 // hi', 'javascript');
    expect(tokens).not.toBeNull();
    expect(tokens!.map((t) => t.text).join('')).toBe('const answer = 42 // hi');
    expect(tokens!.every((t) => /^38;2;\d+;\d+;\d+$/.test(t.fg))).toBe(true);
    // keyword vs comment differ in dark-plus.
    const keyword = tokens!.find((t) => t.text === 'const')!;
    const comment = tokens!.find((t) => t.text.includes('//'))!;
    expect(keyword.fg).not.toBe(comment.fg);
  });

  it('serves repeat renders from the cache with identical output', async () => {
    await ensureLang('javascript');
    const first = highlightLine('let x = 1', 'javascript');
    const second = highlightLine('let x = 1', 'javascript');
    expect(second).toEqual(first);
  });

  it('highlights after the grammar loads even when first asked while unloaded', async () => {
    // `go` is loaded by no other test — the unloaded null must NOT be cached, or this line would stay
    // plain forever once the grammar lands (the poisoned-cache regression).
    const line = 'func main() { println("hi") }';
    expect(highlightLine(line, 'go')).toBeNull();
    await ensureLang('go');
    const tokens = highlightLine(line, 'go');
    expect(tokens).not.toBeNull();
    expect(tokens!.map((t) => t.text).join('')).toBe(line);
  });
});

describe('setCodeHighlightListener', () => {
  it('supports multiple coexisting listeners and unregisters just one', async () => {
    setCodeHighlightListener(null); // start from a clean slate
    let a = 0;
    let b = 0;
    const offA = setCodeHighlightListener(() => { a += 1; });
    const offB = setCodeHighlightListener(() => { b += 1; });
    await ensureLang('ruby');
    expect(a).toBe(1);
    expect(b).toBe(1);
    offA();
    await ensureLang('rust');
    expect(a).toBe(1); // A no longer fires
    expect(b).toBe(2);
    offB();
    setCodeHighlightListener(null);
  });
});

describe('highlightBlock', () => {
  it('returns ANSI lines for a loaded language and null for an unknown one', async () => {
    await ensureLang('json');
    const lines = highlightBlock('{ "ok": true }', 'json');
    expect(lines).toHaveLength(1);
    expect(lines![0]).toContain('\x1b[');
    expect(lines![0]).toContain('{');
    expect(highlightBlock('plain text', 'not-a-language')).toBeNull();
  });
});

describe('wrapTokens', () => {
  const toks = (parts: Array<[string, string]>): CodeToken[] => parts.map(([text, fg]) => ({ text, fg }));

  it('keeps a short line on one row', () => {
    expect(wrapTokens(toks([['abc', '38;2;1;2;3']]), 10)).toEqual([[{ text: 'abc', fg: '38;2;1;2;3' }]]);
  });

  it('splits a token across rows at the wrap point, preserving color', () => {
    const rows = wrapTokens(toks([['abcdef', '38;2;1;2;3']]), 4);
    expect(rows).toEqual([
      [{ text: 'abcd', fg: '38;2;1;2;3' }],
      [{ text: 'ef', fg: '38;2;1;2;3' }],
    ]);
  });

  it('fills each row greedily across token boundaries, preserving colors', () => {
    const rows = wrapTokens(toks([['ab', '38;2;1;1;1'], ['cd', '38;2;2;2;2']]), 3);
    expect(rows).toEqual([
      [{ text: 'ab', fg: '38;2;1;1;1' }, { text: 'c', fg: '38;2;2;2;2' }],
      [{ text: 'd', fg: '38;2;2;2;2' }],
    ]);
  });

  it('never exceeds the width', () => {
    for (const width of [1, 2, 3, 5, 8]) {
      for (const row of wrapTokens(toks([['const x = "abcdefgh"', '38;2;1;2;3']]), width)) {
        expect(row.reduce((sum, t) => sum + visibleWidth(t.text), 0)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('measures wide (CJK) glyphs with visibleWidth so rows never overflow', () => {
    // Each CJK glyph is 2 cells; a row must not exceed the requested width at any width that can hold
    // at least one glyph (a width-1 column cannot fit a 2-cell glyph and is out of scope here).
    for (const width of [2, 3, 4, 7, 8]) {
      for (const row of wrapTokens(toks([['你好世界一二三', '38;2;1;2;3']]), width)) {
        expect(row.reduce((sum, t) => sum + visibleWidth(t.text), 0)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('diff rows with a grammar loaded', () => {
  it('composites token foregrounds over the add background, padding included', async () => {
    await ensureLang('javascript');
    const [row] = diffBlock(JS_ROW, 10, 60, 'javascript').filter((l) => l.includes('const'));
    expect(row).toContain('48;2;3;58;22'); // add background survives around tokens…
    expect(row).toContain('38;2;86;156;214'); // …while the keyword carries its dark-plus blue
    expect(row).toContain('\x1b[0m');
    expect(visibleWidth(row)).toBe(60 + 4); // block indent + padded row
  });

  it('pads a CJK diff row to exactly the requested visible width', async () => {
    await ensureLang('javascript');
    const cjkRow = '+ 3 const 名前 = "你好世界" // 挨拶';
    for (const row of diffBlock(cjkRow, 10, 50, 'javascript')) {
      // block indent (4) + padded row width (50); no wrapped row may exceed it.
      expect(visibleWidth(row)).toBeLessThanOrEqual(50 + 4);
    }
    const bodyRow = diffBlock(cjkRow, 10, 50, 'javascript').find((l) => l.includes('const'))!;
    expect(visibleWidth(bodyRow)).toBe(50 + 4);
  });

  it('falls back to the plain git-style row when the grammar is not loaded', () => {
    const plain = diffBlock(JS_ROW, 10, 60, null).find((l) => l.includes('const'))!;
    const unloaded = diffBlock(JS_ROW, 10, 60, 'terraform').find((l) => l.includes('const'))!;
    expect(unloaded).toBe(plain);
  });

  it('threads the language through framedDiffBlock', async () => {
    await ensureLang('javascript');
    const { lines } = framedDiffBlock(JS_ROW, 80, 'diff', false, 'javascript');
    expect(lines.find((l) => l.includes('const'))).toContain('48;2;3;58;22');
  });
});
