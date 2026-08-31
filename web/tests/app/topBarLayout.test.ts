import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'styles', 'components', 'page-bar.css'), 'utf8');
const toolbarCss = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'styles', 'components', 'page-toolbar.css'), 'utf8');
const topBarSource = readFileSync(join(import.meta.dirname, '..', '..', 'components', 'shell', 'TopBar.tsx'), 'utf8');

describe('chat top bar responsive ownership', () => {
  it('folds chat controls from a callback-ref measurement without creating a Popper containing block', () => {
    expect(topBarSource).toContain('useElementWidth<HTMLElement>()');
    expect(topBarSource).toContain('data-chat-controls-narrow');
    expect(topBarSource).toMatch(/!barMeasured \|\| barWidth <= CHAT_BAR_WIDE_MIN/);
    expect(css).toMatch(/\.top-bar--bar\[data-chat-controls-narrow\][^{]*chat-page-toolbar__wide-controls[^}]*display: none/);
    expect(css).not.toMatch(/\.top-bar--bar\s*\{[^}]*container(?:-type)?\s*:/);
    expect(css).not.toContain('@container top-bar');
  });

  it('lets a mobile toolbar action group shrink and wrap inside its row', () => {
    const rule = toolbarCss.match(/\.page-toolbar__actions\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/max-width:\s*100%/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/flex:\s*0 1 auto/);
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    expect(rule).not.toMatch(/flex:\s*none/);
  });
});
