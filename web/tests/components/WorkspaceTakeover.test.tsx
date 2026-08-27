import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageProvider } from '../../lib/i18n';
import { WorkspaceTakeover } from '../../components/ui/WorkspaceTakeover';

/** The takeover is the surface that replaces the whole application, so the things it has to get right
 *  are the things nobody notices until they are wrong: a way out that a finger can hit and a screen
 *  reader can name, a focus trap, and geometry that survives a mobile browser's collapsing toolbar.
 *  The first three are asserted against the component; the geometry lives in a stylesheet jsdom cannot
 *  evaluate, so it is asserted against the rule that owns it. */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const primitivesCss = readFileSync(join(WEB, 'app', 'styles', 'components', 'primitives.css'), 'utf-8');
/** The component's SHIPPED source — comments removed, because the file documents the very defects it
 *  replaces by name (`h-screen`, `z-50`) and a guard that reads prose would fail on its own rationale. */
const takeoverSource = readFileSync(join(WEB, 'components', 'ui', 'WorkspaceTakeover.tsx'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

function open(props: Partial<Parameters<typeof WorkspaceTakeover>[0]> = {}) {
  const onBack = props.onBack ?? vi.fn();
  const result = render(
    <WorkspaceTakeover title="Project editor" onBack={onBack} {...props}>
      <button type="button">Save</button>
      <button type="button">Revert</button>
    </WorkspaceTakeover>,
    { wrapper: W },
  );
  return { ...result, onBack };
}

describe('WorkspaceTakeover', () => {
  it('names the surface and gives it exactly one labelled way out', () => {
    open();
    // The defect this replaces offered an unlabelled 28x28 chevron as the only exit.
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toHaveClass('overlay-touch-target');
    expect(screen.getByRole('dialog', { name: 'Project editor' })).toBeInTheDocument();
  });

  it('takes a caller-supplied name for the back control', () => {
    open({ backLabel: 'Leave the editor' });
    expect(screen.getByRole('button', { name: 'Leave the editor' })).toBeInTheDocument();
  });

  it('calls the back handler from the control and from Escape', () => {
    const { onBack } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('moves focus into the surface, traps it, and restores it on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = open();
    const surface = screen.getByRole('dialog', { name: 'Project editor' });
    expect(surface).toHaveFocus();

    // Tab from the last control wraps back to the first rather than escaping into the inert page.
    const back = screen.getByRole('button', { name: 'Back' });
    const revert = screen.getByRole('button', { name: 'Revert' });
    revert.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(back).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(revert).toHaveFocus();

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('renders the toolbar slot beside the title', () => {
    open({ toolbar: <button type="button">Fullscreen</button> });
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
  });

  it('sits on the shared modal layer and the shared fullscreen surface, not on geometry of its own', () => {
    open();
    const surface = screen.getByRole('dialog', { name: 'Project editor' });
    expect(surface).toHaveClass('overlay-surface');
    expect(surface).toHaveClass('workspace-takeover');
    expect(surface).toHaveAttribute('data-presentation', 'fullscreen');
    expect(surface.parentElement).toHaveClass('overlay-layer-modal');
    // The bespoke takeover this replaces carried `z-50`, which collided with the navigation drawer, the
    // advisor launcher and the toasts. No literal layer may come back.
    expect(takeoverSource).not.toMatch(/(?<![\w-])-?z-(?:\[\d+\]|\d+)(?![\w.-])/);
    expect(takeoverSource).not.toMatch(/zIndex/);
  });

  it('measures itself in dvh terms and pads the safe area from the tokens', () => {
    // `h-screen`/`100vh` is the LARGE viewport height: with a mobile browser's toolbar shown it is taller
    // than the screen, which is what put the editor's own toolbar under the browser chrome. The rule
    // sizes by `inset: 0` instead, which is the visible viewport by definition, and reads the insets from
    // --safe-*: a raw env() cannot be overridden and silently resolves to 0 where the fallback is missed.
    expect(takeoverSource).not.toMatch(/\d(?:\.\d+)?vh\b/);
    expect(takeoverSource).not.toMatch(/h-screen/);
    const rule = /\.overlay-surface\.workspace-takeover\[data-presentation='fullscreen'\]\s*\{([^}]*)\}/.exec(primitivesCss);
    expect(rule, '.workspace-takeover must keep its geometry in primitives.css').not.toBeNull();
    expect(rule![1]).toContain('inset: 0');
    expect(rule![1]).toContain('padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)');
    expect(rule![1]).not.toMatch(/env\(/);
  });
});
