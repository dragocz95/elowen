import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

describe('global stylesheet imports', () => {
  // CSS ignores an @import that follows any other rule, so ONE rule above the import block drops tokens,
  // components, animations and skins from the build — the whole app renders unstyled while every
  // component test still passes and the build still succeeds. That is a real incident, not a hypothesis.
  //
  // The comparison runs over every rule, not just at-rules: `globals.css` ends with plain `.chat-markdown`
  // selectors, so an @import appended at the BOTTOM of the file is dead in exactly the same way — and a
  // check that only looked at lines starting with `@` could not see the rules that killed it.
  it('keeps every stylesheet import ahead of all other rules', () => {
    const rules = readFileSync(join(repoRoot, 'web', 'app', 'globals.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip comments, including multi-line ones between imports
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const lastImport = rules.findLastIndex((line) => line.startsWith('@import'));
    // `@charset` and a bare `@layer a, b;` declaration are the only things CSS allows to precede an
    // import, so they do not count as "another rule" here.
    const firstOther = rules.findIndex((line) => !line.startsWith('@import') && !line.startsWith('@charset') && !/^@layer\s+[^{]*;$/.test(line));

    expect(lastImport).toBeGreaterThan(-1);
    expect(firstOther, 'globals.css has no rules after its imports — the guard would prove nothing').toBeGreaterThan(-1);
    expect(firstOther).toBeGreaterThan(lastImport);
  });
});
