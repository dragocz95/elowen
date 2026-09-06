import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The CLI and the web chat must read a display diff the SAME way — which sign a row carries, which
 *  line number, where the source text starts, and which grammar the file path selects. Two parsers is
 *  how a row ends up green in one client and grey in the other.
 *
 *  The web cannot import the one module: Turbopack resolves imports relative to the web root and fails
 *  `next build` on anything outside it (see `chatPresentationMirror.test.ts` for the full trap). So the
 *  duplication is deliberate, and this test — not discipline — keeps the copies identical. Edit
 *  src/shared/codeDiff.ts, then copy it over the mirror's body. */
describe('codeDiff mirror', () => {
  const root = resolve(__dirname, '../..');
  const source = readFileSync(resolve(root, 'src/shared/codeDiff.ts'), 'utf8');
  const mirror = readFileSync(resolve(root, 'web/lib/codeDiff.ts'), 'utf8');

  /** Each file opens with its own doc block explaining which side it is; everything after that must
   *  match byte for byte. */
  const body = (text: string) => {
    const end = text.indexOf('*/');
    expect(end).toBeGreaterThan(0);
    return text.slice(end + 2).replace(/^\n+/, '');
  };

  it('keeps the web copy byte-identical to the shared source', () => {
    expect(body(mirror)).toBe(body(source));
  });

  // The mirror only stays safe to bundle while it pulls nothing in: an import would drag Node-only
  // code into the browser, and the daemon side has to compile under NodeNext at the same time.
  it('stays importless on both sides', () => {
    for (const text of [source, mirror]) {
      expect(text).not.toMatch(/^\s*import\s/m);
      expect(text).not.toMatch(/\brequire\(/);
      expect(text).not.toMatch(/\bprocess\.|\b__dirname\b|\bBuffer\b/);
    }
  });
});
