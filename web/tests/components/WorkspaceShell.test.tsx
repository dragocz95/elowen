import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { Bot, Server, Wrench } from 'lucide-react';
import { LanguageProvider } from '../../lib/i18n';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { WorkspaceMetric } from '../../components/ui/WorkspaceHero';
import { CompactWorkspaceHeader, SpatialWorkspaceLayout } from '../../components/ui/WorkspacePrimitives';
import { SpatialControlDeck } from '../../components/ui/SpatialControlDeck';

const COMPONENTS = resolve(process.cwd(), 'app', 'styles', 'components');
const css = (name: string): string => readFileSync(join(COMPONENTS, `${name}.css`), 'utf-8');

/** The body of an at-rule, located by its prelude and matched by brace balance — a regex cannot tell
 *  where a nested block ends, and every claim below is about what is INSIDE a specific query. */
function atRuleBody(source: string, prelude: string): string {
  const start = source.indexOf(prelude);
  expect(start, `missing at-rule: ${prelude}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i);
    }
  }
  throw new Error(`unbalanced at-rule: ${prelude}`);
}

const sections = [
  { id: 'system', label: 'System', description: 'Runtime and security.', icon: Server },
  { id: 'brain', label: 'Models', description: 'Providers and models.', icon: Bot },
];

describe('WorkspaceShell', () => {
  it('renders one shell anatomy for the register variant: hero, mascot, metrics, rail, content', () => {
    const { container } = render(
      <WorkspaceShell
        variant="register"
        hero={{ eyebrow: 'Work', title: 'Memory', description: 'Everything remembered.', mascot: 'idle', metrics: <WorkspaceMetric label="Active" value={4} /> }}
        navigation={{ sections, value: 'system', onChange: vi.fn(), ariaLabel: 'Sections' }}
      >
        <div>Register</div>
      </WorkspaceShell>,
    );

    const shell = container.querySelector('.workspace-shell');
    expect(shell).toHaveAttribute('data-variant', 'register');
    expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByTestId('workspace-hero-mascot')).toBeInTheDocument();
    // The section navigation the command profile mounts. The horizontal rail is the ambient design's and
    // no design this build ships selects it, so asserting the rail here would assert an unreachable page.
    expect(screen.getByRole('radiogroup', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.queryByTestId('spatial-section-rail')).toBeNull();
    expect(screen.getByTestId('spatial-workspace-layout')).toContainElement(screen.getByText('Register'));
  });

  it('drops the hero body entirely when a variant has neither mascot nor metrics', () => {
    const { container } = render(
      <WorkspaceShell variant="single" hero={{ title: 'Editor' }}>
        <div>Surface</div>
      </WorkspaceShell>,
    );

    expect(container.querySelector('.workspace-hero__body')).toBeNull();
    expect(screen.queryByTestId('workspace-hero-mascot')).toBeNull();
    expect(screen.queryByRole('radiogroup'), 'a variant with no navigation must mount none').toBeNull();
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('Surface'));
  });

  it('omits the action row when a hero has neither status nor action', () => {
    const { container } = render(<WorkspaceShell variant="single" hero={{ title: 'Editor' }}>x</WorkspaceShell>);
    expect(container.querySelector('.workspace-hero__actions')).toBeNull();
  });

  it('wraps the status so a narrow action row can stretch the actions without stretching it', () => {
    const { container } = render(
      <WorkspaceShell variant="single" hero={{ title: 'Editor', status: <span>Saved</span>, action: <button type="button">New</button> }}>x</WorkspaceShell>,
    );
    expect(container.querySelector('.workspace-hero__status')).toContainElement(screen.getByText('Saved'));
    expect(container.querySelector('.workspace-hero__actions')).toContainElement(screen.getByRole('button', { name: 'New' }));
  });
});

describe('the pre-unification names are aliases onto the same shell', () => {
  it('SpatialWorkspaceLayout renders the register variant', () => {
    const { container } = render(
      <SpatialWorkspaceLayout
        hero={{ eyebrow: 'Work', title: 'Projects', metrics: <WorkspaceMetric label="Total" value={2} /> }}
        navigation={{ sections, value: 'system', onChange: vi.fn(), ariaLabel: 'Sections' }}
      >
        <div>Rows</div>
      </SpatialWorkspaceLayout>,
    );

    expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-variant', 'register');
    // The default mascot state survived the move: omitting mascotState still renders the panel.
    expect(screen.getByTestId('workspace-hero-mascot')).toBeInTheDocument();
    expect(screen.getByTestId('spatial-workspace-layout')).toContainElement(screen.getByText('Rows'));
  });

  it('SpatialControlDeck renders the deck variant, with the compact title block when no hero is given', () => {
    const { container } = render(
      <LanguageProvider>
        <SpatialControlDeck eyebrow="Settings" ariaLabel="Settings sections" sections={sections} value="system" onChange={vi.fn()}>
          <div>Section</div>
        </SpatialControlDeck>
      </LanguageProvider>,
    );

    expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-variant', 'deck');
    expect(screen.getByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-hero-mascot')).toBeNull();
    expect(container.querySelector('.workspace-hero__body')).toBeNull();
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('Section'));
  });

  it('SpatialControlDeck opens the mascot hero when one is supplied', () => {
    render(
      <LanguageProvider>
        <SpatialControlDeck
          eyebrow="Settings"
          ariaLabel="Settings sections"
          sections={sections}
          value="system"
          onChange={vi.fn()}
          hero={{ metrics: <WorkspaceMetric label="Uptime" value="4 d" /> }}
        >
          <div>Section</div>
        </SpatialControlDeck>
      </LanguageProvider>,
    );

    expect(screen.getByTestId('workspace-hero-mascot')).toBeInTheDocument();
    expect(screen.getByText('Uptime')).toBeInTheDocument();
  });

  it('CompactWorkspaceHeader is the mascot-less hero and nothing else', () => {
    const { container } = render(
      <CompactWorkspaceHeader eyebrow="Plugin" title="Editor" count={3} description="Files" icon={Wrench} action={<button type="button">Save</button>} />,
    );

    expect(container.querySelector('.workspace-hero')).not.toBeNull();
    expect(container.querySelector('.workspace-hero__icon')).not.toBeNull();
    expect(container.querySelector('.workspace-hero__body')).toBeNull();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});

/* jsdom evaluates neither container queries nor pointer media, so the geometry defects this pass exists
 * to fix are invisible to a rendering test. They are asserted against the stylesheet instead — which is
 * where each of them actually lived. */
describe('the shell stylesheets carry one authority per decision', () => {
  it('caps and gutters every full-page surface in a single rule, with no competing literal', () => {
    const shell = css('workspace-shell');
    expect(shell).toMatch(/\.workspace-shell,\s*\n\.workspace-page\s*\{[^}]*max-width:\s*var\(--content-max\)/);
    expect(shell).toMatch(/\.workspace-shell,\s*\n\.workspace-page\s*\{[^}]*padding-inline-start:\s*max\(var\(--shell-gutter\), var\(--safe-left\)\)/);

    // The deck's own frame, its hardcoded cap and the three phone-width gutter overrides are gone.
    for (const part of ['workspace-shell', 'workspace-hero', 'spatial-deck']) {
      expect(css(part), `${part}.css still restates a width cap`).not.toMatch(/97\.5rem/);
      expect(css(part), `${part}.css still overrides the gutter by viewport`).not.toMatch(/@media \(max-width: (720|900|620)px\)/);
    }
    expect(css('spatial-deck')).not.toMatch(/\.spatial-control-deck|\.spatial-deck-heading/);
  });

  it('stacks wrapped hero actions predictably instead of alternating their alignment', () => {
    const narrow = atRuleBody(css('workspace-hero'), '@container workspace-hero (width < 48rem)');
    expect(narrow).toMatch(/\.workspace-hero__actions\s*\{[^}]*justify-content:\s*flex-start/);
    expect(narrow).not.toMatch(/justify-content:\s*space-between/);
    // Each action fills its row, so the primary one is in the same place on every wrapped line.
    expect(narrow).toMatch(/\.workspace-hero__actions > :not\(\.workspace-hero__status\)\s*\{[^}]*flex:\s*1 1 10rem/);
  });

  it('collapses the phone hero so the content starts on the first screen', () => {
    const phone = atRuleBody(css('workspace-hero'), '@container workspace-hero (width < 34rem)');
    expect(phone).toMatch(/\.workspace-hero__mascot\s*\{[^}]*display:\s*none/);
    // A compact horizontal strip, not the 12rem metric panel.
    expect(phone).toMatch(/\.workspace-hero__metrics\s*\{[^}]*display:\s*flex/);
    expect(phone).toMatch(/\.workspace-metric\s*\{[^}]*padding:\s*0\.7rem/);
  });

  it('compresses against the width of the hero itself, never the viewport', () => {
    const hero = css('workspace-hero');
    expect(hero).toMatch(/\.workspace-hero\s*\{[^}]*container:\s*workspace-hero \/ inline-size/);
    // A viewport media query here would not fire for a hero narrowed by the advisor dock.
    expect(hero.match(/@media \([^)]*width[^)]*\)/g)).toBeNull();
  });

  it('guarantees the touch minimum for a hero action, but not for the status live region', () => {
    const coarse = atRuleBody(css('workspace-hero'), '@media (pointer: coarse)');
    expect(coarse).toMatch(/:not\(\.workspace-hero__status\)\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
  });

  it('collapses a page toolbar whose every control currently renders nothing', () => {
    const shell = css('workspace-shell');
    expect(shell).toMatch(/\.module-header__toolbar:not\(:has\(> :not\(:empty\).*?\)\)\s*\{\s*display:\s*none/);
    expect(shell).toMatch(/\.module-header:not\(:has\(> p\)\)/);
  });
});
