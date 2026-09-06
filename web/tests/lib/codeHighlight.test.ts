import { describe, it, expect } from 'vitest';
import { highlightCode, type CodeToken } from '../../lib/codeHighlight';

/** The lexer's contract is coarse on purpose (see the module's own doc block): it colours the Monokai
 *  categories over one line at a time and never claims to understand the language. What it may NOT do is
 *  lose or reorder source text, or swallow a row into a comment — a diff row that renders as anything
 *  other than its own characters is worse than no colour at all. */

const text = (tokens: CodeToken[]): string => tokens.map((t) => t.text).join('');
/** The kind of the token carrying `word`. Matched by substring because neighbouring fragments of one
 *  kind are merged: an identifier keeps the plain space before it in the same token. */
const kindOf = (tokens: CodeToken[], word: string): string | undefined => tokens.find((t) => t.text.includes(word))?.kind;

describe('highlightCode', () => {
  it('leaves an unknown language as a single plain token', () => {
    expect(highlightCode('anything at all', null)).toEqual([{ text: 'anything at all', kind: 'plain' }]);
    expect(highlightCode('anything at all', 'brainfuck')).toEqual([{ text: 'anything at all', kind: 'plain' }]);
    expect(highlightCode('', 'typescript')).toEqual([]);
  });

  it('reproduces the source exactly, whatever it colours', () => {
    const samples: [string, string][] = [
      ['typescript', 'export const answer = 42; // life'],
      ['typescript', 'const s = `a ${b} c`; /* mid'],
      ['css', '.chat-diff { color: var(--color-code-plain); /* note */ }'],
      ['python', 'def run(self, x: int = 3) -> None:'],
      ['bash', 'for f in *.ts; do echo "$f"; done # loop'],
      ['json', '{ "a": [1, 2.5, true, null] }'],
      ['yaml', 'services:  - name: web  # comment'],
      ['typescript', 'i--; j++; a -= 1;'],
    ];
    for (const [lang, source] of samples) {
      expect(text(highlightCode(source, lang)), `${lang}: ${source}`).toBe(source);
    }
  });

  it('paints the TypeScript categories the CLI palette names', () => {
    const tokens = highlightCode('export const answer: number = 42; // life', 'typescript');
    expect(kindOf(tokens, 'export')).toBe('keyword');
    expect(kindOf(tokens, 'const')).toBe('keyword');
    expect(kindOf(tokens, 'number')).toBe('type');
    expect(kindOf(tokens, '42')).toBe('number');
    expect(tokens.at(-1)).toEqual({ text: '// life', kind: 'comment' });
  });

  it('reads strings, calls and type names', () => {
    const tokens = highlightCode('const label = format("a b", Date.now());', 'typescript');
    expect(kindOf(tokens, '"a b"')).toBe('string');
    expect(kindOf(tokens, 'format')).toBe('function');
    expect(kindOf(tokens, 'Date')).toBe('type');
    // An ALL_CAPS constant is not a type name, however capitalized it is.
    expect(kindOf(highlightCode('const X = DIFF_MAX_ROWS;', 'typescript'), 'DIFF_MAX_ROWS')).toBe('plain');
  });

  it('does not read a C-family decrement as a line comment', () => {
    // `--` opens a comment in SQL only. Registering it for the C family swallowed the rest of the row.
    const tokens = highlightCode('while (i-- > 0) { total += i; }', 'typescript');
    expect(tokens.some((t) => t.kind === 'comment')).toBe(false);
    expect(kindOf(highlightCode('SELECT 1 -- count', 'sql'), '-- count')).toBe('comment');
  });

  it('keeps an unterminated string or block comment inside its own row', () => {
    // A diff row is a fragment: a template literal or a block comment opened on an earlier line is
    // normal input. It must colour to the end of the row and not throw or drop the tail.
    expect(text(highlightCode('const s = "half a str', 'typescript'))).toBe('const s = "half a str');
    expect(highlightCode('const s = "half a str', 'typescript').at(-1)?.kind).toBe('string');
    expect(highlightCode('/* opened earlier', 'typescript')).toEqual([{ text: '/* opened earlier', kind: 'comment' }]);
  });

  it('colours CSS custom properties, hex colours and at-rules', () => {
    const tokens = highlightCode('  --color-diff-add: #005f00;', 'css');
    expect(kindOf(tokens, '--color-diff-add')).toBe('plain');
    expect(kindOf(tokens, '#005f00')).toBe('number');
    expect(kindOf(highlightCode('@media (min-width: 40rem) {', 'css'), '@media')).toBe('plain');
    expect(kindOf(highlightCode('.row { padding: 0.5rem 1rem; }', 'css'), '0.5rem')).toBe('number');
  });

  it('does not read a protocol-relative URL as a CSS comment', () => {
    // CSS has no line comment. Registering `//` swallowed the rest of any declaration holding a URL.
    const tokens = highlightCode('  background: url(https://cdn.example.com/a.png);', 'css');
    expect(tokens.some((t) => t.kind === 'comment')).toBe(false);
    expect(highlightCode('/* real css comment */', 'css').at(0)?.kind).toBe('comment');
  });

  it('leaves an apostrophe in a YAML scalar alone', () => {
    const tokens = highlightCode("  description: it's fine", 'yaml');
    expect(tokens.some((t) => t.kind === 'string')).toBe(false);
    expect(kindOf(highlightCode('  name: "web"', 'yaml'), '"web"')).toBe('string');
  });

  it('gives up on a row too long to be code anyone reads', () => {
    // A minified bundle or a base64 blob would otherwise become a DOM node every few characters.
    const huge = `const x = "${'a'.repeat(2100)}";`;
    expect(highlightCode(huge, 'typescript')).toEqual([{ text: huge, kind: 'plain' }]);
  });

  it('does not resolve a language id through Object.prototype', () => {
    expect(highlightCode('const a = 1;', 'constructor')).toEqual([{ text: 'const a = 1;', kind: 'plain' }]);
    expect(highlightCode('const a = 1;', 'toString')).toEqual([{ text: 'const a = 1;', kind: 'plain' }]);
  });

  it('merges neighbouring fragments of one kind into a single token', () => {
    // The renderer emits one span per token; a per-character token list would be a DOM node per glyph.
    const tokens = highlightCode('const a = 1;', 'typescript');
    expect(tokens.length).toBeLessThan(8);
    for (let i = 1; i < tokens.length; i += 1) expect(tokens[i]!.kind).not.toBe(tokens[i - 1]!.kind);
  });
});
