import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

describe('global stylesheet imports', () => {
  // CSS ignores an @import that follows another rule, so a stray at-rule above the import block drops
  // tokens, components, animations and skins from the build — the whole app renders unstyled while every
  // component test still passes and the build still succeeds.
  it('keeps every stylesheet import ahead of all other at-rules', () => {
    const atRules = readFileSync(join(repoRoot, 'web', 'app', 'globals.css'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('@'));
    const lastImport = atRules.findLastIndex((line) => line.startsWith('@import'));
    const firstOther = atRules.findIndex((line) => !line.startsWith('@import'));

    expect(lastImport).toBeGreaterThan(-1);
    if (firstOther > -1) expect(firstOther).toBeGreaterThan(lastImport);
  });
});
