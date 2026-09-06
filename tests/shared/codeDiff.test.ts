import { describe, it, expect } from 'vitest';
import { langForPath, parseDiffRow } from '../../src/shared/codeDiff.js';

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

describe('parseDiffRow', () => {
  it('reads the pi format: sign first, then the line number', () => {
    expect(parseDiffRow('+   12 const answer = 42')).toEqual({ sign: '+', num: '12', text: 'const answer = 42' });
    expect(parseDiffRow('-    2 old')).toEqual({ sign: '-', num: '2', text: 'old' });
    expect(parseDiffRow('    7 kept')).toEqual({ sign: ' ', num: '7', text: 'kept' });
  });

  it('prefers the legacy parse when the pi sign is blank', () => {
    // '   2 - old' matches BOTH shapes; read as pi it would carry a blank sign and leak the '-' into
    // the source text, rendering a delete as an unchanged context row.
    expect(parseDiffRow('   2 - old')).toEqual({ sign: '-', num: '2', text: 'old' });
    expect(parseDiffRow('   2 + new')).toEqual({ sign: '+', num: '2', text: 'new' });
  });

  it('reads a bare unified row, which carries no line number', () => {
    expect(parseDiffRow('+added')).toEqual({ sign: '+', num: '', text: 'added' });
    expect(parseDiffRow('-removed')).toEqual({ sign: '-', num: '', text: 'removed' });
  });

  it('leaves unified file headers and hunk headers unsigned', () => {
    // `+++ b/file` is a HEADER, not an added line: signing it would paint the file name green.
    expect(parseDiffRow('+++ b/src/app.ts')).toBeNull();
    expect(parseDiffRow('--- a/src/app.ts')).toBeNull();
    expect(parseDiffRow('@@ -1,4 +1,6 @@')).toBeNull();
    expect(parseDiffRow('')).toBeNull();
  });
});
