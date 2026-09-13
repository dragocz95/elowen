import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CSS = readFileSync(join(resolve(process.cwd()), 'app', 'styles', 'components', 'page-toolbar.css'), 'utf-8');

const block = (selector: string): string => {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`Missing selector: ${selector}`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
};

describe('page filter panel layout', () => {
  it('wraps long segmented filters inside the viewport-clamped panel', () => {
    expect(block('.page-filters__panel')).toMatch(/max-width:\s*calc\(100vw - 2rem\)/);
    const segmented = block(".page-filters__field-control .segmented[aria-orientation='horizontal']");
    expect(segmented).toMatch(/display:\s*flex/);
    expect(segmented).toMatch(/width:\s*100%/);
    expect(segmented).toMatch(/flex-wrap:\s*wrap/);
  });
});
