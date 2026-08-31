import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const studio = readFileSync(join(import.meta.dirname, '..', '..', 'skins', 'studio', 'shared.css'), 'utf8');
const primitives = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'styles', 'components', 'primitives.css'), 'utf8');

describe('mobile shell first paint', () => {
  it('scopes both navigation fail-safes to the explicit unmeasured state and exact 1024px boundary', () => {
    for (const [name, css, selector] of [
      ['Studio', studio, ".studio-nav[data-measured='false']:not([data-mode='drawer'])"],
      ['Orbital', primitives, ".orbital-nav[data-measured='false']:not([data-mode='drawer'])"],
    ] as const) {
      const phone = css.slice(css.indexOf('@media (max-width: 1023px)'));
      expect(phone, `${name} exact breakpoint`).toContain(selector);
      expect(phone, `${name} leaves measured modes alone`).not.toContain(`[data-measured='true']`);
      expect(phone).toMatch(/data-side='left'[^}]*transform:\s*translateX\(-100%\)/);
      expect(phone).toMatch(/data-side='right'[^}]*transform:\s*translateX\(100%\)/);
    }
    expect(studio).not.toContain('@media (width < 64rem)');
  });
});
