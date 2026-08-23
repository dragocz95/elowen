import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The CLI and the web chat must apply the SAME presentation rules — the Todo excerpt and the
 *  compose-marker thresholds — and the honest way to share a rule is one module. The web cannot have
 *  that one module: Turbopack resolves imports relative to the web root and fails `next build` on
 *  anything outside it, suffix or no suffix. `lib/types.ts` imports the wire contract from src/ only
 *  because that import is TYPE-ONLY and is erased before resolution ever runs.
 *
 *  What makes that trap expensive is WHERE it surfaces: `tsc --noEmit` and vitest both resolve the
 *  cross-root import happily, so the mistake ships through every gate we run during development and
 *  only appears in the production build. So the duplication is deliberate, and this test — not
 *  discipline — is what keeps the copies identical. Edit src/shared/chatPresentation.ts, then copy it
 *  over the mirror's body. */
describe('chatPresentation mirror', () => {
  const root = resolve(__dirname, '../..');
  const source = readFileSync(resolve(root, 'src/shared/chatPresentation.ts'), 'utf8');
  const mirror = readFileSync(resolve(root, 'web/lib/chatPresentation.ts'), 'utf8');

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
