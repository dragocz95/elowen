import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', 'styles', 'components', 'primitives.css'),
  'utf8',
);

/** The nowrap Segmented track hides native scrollbar chrome, but exposes measured left/right overflow to
 *  a mask. A fitting track stays fully opaque; only an edge with unreachable content receives the fade. */
describe('section tabs scroll affordance', () => {
  it('keeps the scrollbar hidden and derives both fade edges from CSS variables', () => {
    const nowrap = /\.segmented\[data-nowrap='true'\]\s*\{([^}]*)\}/.exec(css);
    expect(nowrap).not.toBeNull();
    expect(nowrap![1]).toMatch(/scrollbar-width:\s*none/);
    expect(nowrap![1]).toMatch(/mask-image:\s*linear-gradient/);
    expect(nowrap![1]).toContain('var(--segmented-edge-fade-left)');
    expect(nowrap![1]).toContain('var(--segmented-edge-fade-right)');
  });

  it('defaults both edges to no fade until measured overflow says otherwise', () => {
    expect(css).toMatch(/--segmented-edge-fade-left:\s*0px/);
    expect(css).toMatch(/--segmented-edge-fade-right:\s*0px/);
  });
});
