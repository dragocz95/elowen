import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Lived inside the Discord plugin's suite until that plugin moved to the registry — it is really a guard
 *  on the FILES manifest, which stays here. A chat surface prints `manifest.icon` verbatim (Discord's
 *  stream.mjs toolLine does `${c.icon ?? '🔧'}`), so a word value like "file"/"edit"/"search" — the
 *  original bug — renders as literal text and reads as a missing icon. */
describe('files plugin tool icons are emoji glyphs', () => {
  it('every icon value in the files manifest is a real emoji, with the expected mapping', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugins/files/elowen-plugin.json'), 'utf-8')) as { icons: Record<string, string> };
    const emoji = /\p{Extended_Pictographic}/u;
    for (const [tool, icon] of Object.entries(manifest.icons)) {
      expect(emoji.test(icon), `${tool} icon "${icon}" must be an emoji glyph`).toBe(true);
    }
    expect(manifest.icons).toMatchObject({
      Read: '📄', ListDir: '📂', Write: '✏️', Edit: '✏️', Search: '🔎', FileInfo: '📄', GitStatus: '🌿',
    });
  });
});
