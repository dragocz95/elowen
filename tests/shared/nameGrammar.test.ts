import { describe, it, expect } from 'vitest';
import { NAME_RE } from '../../src/shared/nameGrammar.js';

/** Characterization of the kebab-case name grammar that guards agent names, plugin names and the single
 *  path segment each of them becomes on disk. Every pair below is the behavior the daemon shipped before
 *  the grammar moved to its own module, so an accidental loosening shows up here rather than as a
 *  traversal or a rejected-but-legal name. */
describe('NAME_RE', () => {
  const accepts = [
    'ab',
    'a1',
    '0a',
    '9-9',
    'a-b',
    'a--b',
    'plan',
    'elowen-docs',
    'a'.repeat(64),
    // A trailing dash is legal today: the last character is matched by the same class as the middle.
    'a-',
  ];

  const rejects = [
    '',
    'a',                    // one char — the {1,63} tail needs at least one more
    'a'.repeat(65),
    'A',
    'Ab',
    'aB',
    '-a',                   // must start with a letter or digit
    'a_b',
    'a.b',
    'a/b',
    'a\\b',
    '..',
    '.',
    'a b',
    ' ab',
    'ab ',
    'abc\n',                // `$` is not multiline: a trailing newline cannot smuggle a name past the guard
    '\nabc',
    'a\u0000b',
    'ábč',
    'ab\u200b',
  ];

  for (const name of accepts) {
    it(`accepts ${JSON.stringify(name)}`, () => {
      expect(NAME_RE.test(name)).toBe(true);
    });
  }

  for (const name of rejects) {
    it(`rejects ${JSON.stringify(name)}`, () => {
      expect(NAME_RE.test(name)).toBe(false);
    });
  }

  it('is stateless — no /g flag, so repeated tests do not alternate', () => {
    expect(NAME_RE.global).toBe(false);
    expect(NAME_RE.test('plan')).toBe(true);
    expect(NAME_RE.test('plan')).toBe(true);
  });
});
