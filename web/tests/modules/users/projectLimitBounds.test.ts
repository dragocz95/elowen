import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/** The managed-project limit is bounded in TWO places that have to agree. The daemon decides which value
 *  survives a PATCH (`userPermissionsSchema` in `src/api/schemas/auth.ts`), and the admin drawer's slider
 *  must offer exactly that range: narrower and an admin can no longer set a limit the route accepts;
 *  wider and the slider offers one the route rejects with a 400.
 *
 *  The web may not import from `src/` (dependency-cruiser's `web-not-to-backend` rule), so the pair is
 *  compared as TEXT — reading a file is not a module dependency. Same technique as
 *  `web/tests/modules/account/terminalCliParity.test.ts`. */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('managed project limit — daemon schema and the admin slider', () => {
  it('offers exactly the integers the PATCH route accepts', () => {
    const schema = read('../../../../src/api/schemas/auth.ts');
    const found = /project_limit: z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(schema);
    expect(found, 'project_limit not found in the shape this test compares').toBeTruthy();

    const web = read('../../../modules/users/ProjectPermissions.tsx');
    const bounds = /const PROJECT_LIMIT_BOUNDS: \[min: number, max: number\] = \[(\d+), (\d+)\];/.exec(web);
    expect(bounds, 'PROJECT_LIMIT_BOUNDS not found in the shape this test compares').toBeTruthy();

    expect([bounds![1], bounds![2]]).toEqual([found![1], found![2]]);
  });

  // The route takes any integer in range, so the slider's step has to be 1. A coarser step would quietly
  // make most accepted values unreachable from the only UI that sets them.
  it('steps by a single project', () => {
    const web = read('../../../modules/users/ProjectPermissions.tsx');
    expect(/step=\{1\}/.test(web), 'the limit slider must step by 1').toBe(true);
  });

  // The seed an account with no stored limit falls back to must sit inside the bounds, or simply opening
  // the drawer would offer a value the route refuses.
  it('keeps the fallback seed inside the bounds', () => {
    const web = read('../../../modules/users/ProjectPermissions.tsx');
    const bounds = /const PROJECT_LIMIT_BOUNDS: \[min: number, max: number\] = \[(\d+), (\d+)\];/.exec(web)!;
    const fallback = /const PROJECT_LIMIT_FALLBACK = (\d+);/.exec(web);
    expect(fallback, 'PROJECT_LIMIT_FALLBACK not found').toBeTruthy();
    expect(Number(fallback![1])).toBeGreaterThanOrEqual(Number(bounds[1]));
    expect(Number(fallback![1])).toBeLessThanOrEqual(Number(bounds[2]));
  });
});
