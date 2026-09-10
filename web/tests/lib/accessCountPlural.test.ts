import { describe, expect, it } from 'vitest';
import { plural } from '../../lib/i18n/plural';
import { dictionaries } from '../../lib/i18n/dictionaries';

/** The counted labels render through the shared plural rule, so Czech and Slovak get the 1 / 2–4 / 5+
 *  forms their grammar requires instead of one frozen genitive plural. The rendered string is what these
 *  assert: a label that reads "Přístup má 1 uživatelů" is wrong however correct the count is. */
const render = (forms: { one: string; few: string; many: string }, count: number) =>
  plural(forms, count).replace('{n}', String(count));

describe('access counts agree with the number they carry', () => {
  it('names the member count in every locale', () => {
    const cases: [keyof typeof dictionaries, number, string][] = [
      ['en', 1, '1 user has access'], ['en', 2, '2 users have access'], ['en', 5, '5 users have access'],
      ['cs', 1, 'Přístup má 1 uživatel'], ['cs', 2, 'Přístup mají 2 uživatelé'], ['cs', 5, 'Přístup má 5 uživatelů'],
      ['sk', 1, 'Prístup má 1 používateľ'], ['sk', 2, 'Prístup majú 2 používatelia'], ['sk', 5, 'Prístup má 5 používateľov'],
    ];
    for (const [locale, count, expected] of cases) {
      expect(render(dictionaries[locale].projects.accessCountMembers, count)).toBe(expected);
    }
  });

  it('names the selected count in every locale', () => {
    const cases: [keyof typeof dictionaries, number, string][] = [
      ['en', 1, '1 user selected'], ['en', 2, '2 users selected'], ['en', 5, '5 users selected'],
      ['cs', 1, 'Vybrán 1 uživatel'], ['cs', 2, 'Vybráni 2 uživatelé'], ['cs', 5, 'Vybráno 5 uživatelů'],
      ['sk', 1, 'Vybraný 1 používateľ'], ['sk', 2, 'Vybraní 2 používatelia'], ['sk', 5, 'Vybraných 5 používateľov'],
    ];
    for (const [locale, count, expected] of cases) {
      expect(render(dictionaries[locale].projects.accessSelected, count)).toBe(expected);
    }
  });

  /** Zero takes the same form as five in both languages, and an empty project is a real state. */
  it('treats zero as the many form', () => {
    expect(render(dictionaries.cs.projects.accessCountMembers, 0)).toBe('Přístup má 0 uživatelů');
    expect(render(dictionaries.sk.projects.accessSelected, 0)).toBe('Vybraných 0 používateľov');
  });
});
