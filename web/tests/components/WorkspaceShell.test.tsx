import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import { Bot, Server, Wrench } from 'lucide-react';
import { LanguageProvider } from '../../lib/i18n';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { WorkspaceMetric } from '../../components/ui/WorkspaceHero';
import { CompactWorkspaceHeader, SpatialWorkspaceLayout } from '../../components/ui/WorkspacePrimitives';
import { SpatialControlDeck } from '../../components/ui/SpatialControlDeck';
import { PHONE_MAX_WIDTH } from '../../lib/breakpoints';
import { watchMounts } from '../test-utils';

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

function setViewportWidth(width: number): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: /max-width:\s*(\d+)px/.test(query) && width <= Number(/max-width:\s*(\d+)px/.exec(query)![1]),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  } as MediaQueryList));
}

afterEach(() => vi.restoreAllMocks());

/** The class each direct child of an element is identified by. The anatomy of a page is an ORDER, and an
 *  order is the one thing a per-element `toBeInTheDocument` cannot see: every assertion below passed just
 *  as happily when the toolbar sat above the title. */
const anatomy = (element: Element | null): string[] =>
  [...(element?.children ?? [])].map((child) => child.className.split(' ')[0]!);

describe('WorkspaceShell', () => {
  it('renders one shell anatomy for the register variant: hero, metric rail, section nav, toolbar, content', () => {
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
    expect(anatomy(shell)).toEqual([
      'workspace-hero',
      'workspace-shell__section-navigation',
      'page-toolbar',
      'workspace-shell__content',
    ]);
    // The heading first, the metric rail directly under it — never the other way round.
    expect(anatomy(container.querySelector('.workspace-hero'))).toEqual(['workspace-hero__head', 'workspace-hero__metrics']);
    expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeInTheDocument();
    expect(screen.getByTestId('workspace-hero-metrics')).toContainElement(screen.getByText('Active'));
    // The section navigation is IN THE PAGE. The horizontal rail is still exported for the bundles that
    // mount it themselves, but the shell chooses it for nobody.
    expect(screen.getByRole('radiogroup', { name: 'Sections' })).toBeInTheDocument();
    expect(screen.queryByTestId('spatial-section-rail')).toBeNull();
    expect(screen.getByTestId('spatial-workspace-layout')).toContainElement(screen.getByText('Register'));
  });

  it('keeps the mascot prop as an inert visual state input and mounts no artwork for it', () => {
    const { container } = render(
      <WorkspaceShell variant="register" hero={{ title: 'Memory', mascot: 'saving', metrics: <WorkspaceMetric label="Active" value={4} /> }}>
        <div>Register</div>
      </WorkspaceShell>,
    );

    // The published prop still reaches the DOM, so a design can answer the page's state in CSS…
    expect(container.querySelector('.workspace-hero')).toHaveAttribute('data-mascot', 'saving');
    // …and the decorative column it used to open is gone from the markup entirely.
    expect(container.querySelector('.workspace-hero__mascot')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Elowen' })).toBeNull();
  });

  it('drops the metric rail entirely when a variant has no metrics', () => {
    const { container } = render(
      <WorkspaceShell variant="single" hero={{ title: 'Editor' }}>
        <div>Surface</div>
      </WorkspaceShell>,
    );

    expect(container.querySelector('.workspace-hero__metrics')).toBeNull();
    expect(container.querySelector('.workspace-hero')).not.toHaveAttribute('data-mascot');
    expect(screen.queryByRole('radiogroup'), 'a variant with no navigation must mount none').toBeNull();
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('Surface'));
  });

  it('mounts the toolbar row on a page that passes it nothing, because it carries the portal slot', () => {
    render(<WorkspaceShell variant="single" hero={{ title: 'Editor' }}>x</WorkspaceShell>);
    expect(screen.getByTestId('page-toolbar-slot')).toBeEmptyDOMElement();
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

/** The public navigation model stays unchanged. WorkspaceShell alone decides whether a deck gets its
 *  vertical menu or phone tabs; registers never participate in that responsive branch. */
describe('responsive section navigation', () => {
  const renderDeck = (count = false) => render(
    <LanguageProvider>
      <SpatialControlDeck
        eyebrow="Settings"
        ariaLabel="Settings sections"
        sections={count ? [{ ...sections[0]!, count: 3 }, sections[1]!] : sections}
        value="system"
        onChange={vi.fn()}
      >
        <div>Section</div>
      </SpatialControlDeck>
    </LanguageProvider>,
  );

  const assertTabs = (container: HTMLElement, ariaLabel: string) => {
    const shell = container.querySelector('.workspace-shell');
    const nav = container.querySelector('.workspace-shell__section-navigation');
    expect(shell).toHaveAttribute('data-section-layout', 'tabs');
    expect(nav).toHaveAttribute('data-layout', 'tabs');
    const group = screen.getByRole('radiogroup', { name: ariaLabel });
    expect(group).toHaveAttribute('data-variant', 'line');
    expect(group).toHaveAttribute('data-nowrap', 'true');
    expect(group).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(nav?.querySelectorAll('.segmented__option > svg')).toHaveLength(0);
  };

  it('renders a deck as a vertical menu on tablet and desktop, preserving icons and counts', async () => {
    setViewportWidth(PHONE_MAX_WIDTH + 1);
    const { container } = renderDeck(true);

    await waitFor(() => expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'sidebar'));
    const nav = container.querySelector('.workspace-shell__section-navigation');
    expect(nav).toHaveAttribute('data-layout', 'sidebar');
    const group = screen.getByRole('radiogroup', { name: 'Settings sections' });
    expect(group).toHaveAttribute('data-variant', 'menu');
    expect(group).not.toHaveAttribute('data-nowrap');
    expect(group).toHaveAttribute('aria-orientation', 'vertical');
    expect(nav?.querySelectorAll('.segmented__option > svg')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'System 3' })).toHaveTextContent('System3');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('renders a phone deck as line tabs and never mounts the desktop menu first', async () => {
    setViewportWidth(PHONE_MAX_WIDTH);
    const sawSidebar = watchMounts(".workspace-shell__section-navigation[data-layout='sidebar']");
    const { container } = renderDeck();

    await waitFor(() => assertTabs(container, 'Settings sections'));
    expect(sawSidebar()).toBe(false);
  });

  it('switches exactly at the 767/768 boundary', async () => {
    setViewportWidth(PHONE_MAX_WIDTH);
    const phone = renderDeck();
    await waitFor(() => expect(phone.container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'tabs'));
    phone.unmount();
    vi.restoreAllMocks();

    setViewportWidth(PHONE_MAX_WIDTH + 1);
    const tablet = renderDeck();
    await waitFor(() => expect(tablet.container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'sidebar'));
  });

  it('keeps a register on horizontal tabs at every width', () => {
    setViewportWidth(PHONE_MAX_WIDTH + 1);
    const { container } = render(
      <WorkspaceShell
        variant="register"
        hero={{ title: 'Memory', metrics: <WorkspaceMetric label="Active" value={4} /> }}
        navigation={{ sections, value: 'system', onChange: vi.fn(), ariaLabel: 'Sections' }}
      >
        <div>Register</div>
      </WorkspaceShell>,
    );

    assertTabs(container, 'Sections');
  });

  it('keeps mobile DOM flow hero, tabs, toolbar, content', async () => {
    setViewportWidth(PHONE_MAX_WIDTH);
    const { container } = renderDeck();
    await screen.findByRole('radiogroup', { name: 'Settings sections' });

    expect(anatomy(container.querySelector('.workspace-shell'))).toEqual([
      'workspace-hero',
      'workspace-shell__section-navigation',
      'page-toolbar',
      'workspace-shell__content',
    ]);
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
    // The alias's default mascot state survived the move; it now reaches the DOM as state, not artwork.
    expect(container.querySelector('.workspace-hero')).toHaveAttribute('data-mascot', 'idle');
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
    expect(container.querySelector('.workspace-hero__metrics')).toBeNull();
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('Section'));
  });

  it('SpatialControlDeck opens the metric rail when a hero is supplied', () => {
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

    expect(screen.getByTestId('workspace-hero-metrics')).toContainElement(screen.getByText('Uptime'));
  });

  it('CompactWorkspaceHeader is the title block and nothing else', () => {
    const { container } = render(
      <CompactWorkspaceHeader eyebrow="Plugin" title="Editor" count={3} description="Files" icon={Wrench} action={<button type="button">Save</button>} />,
    );

    expect(container.querySelector('.workspace-hero')).not.toBeNull();
    expect(container.querySelector('.workspace-hero__icon')).not.toBeNull();
    expect(container.querySelector('.workspace-hero__metrics')).toBeNull();
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
    const hero = css('workspace-hero');
    const phone = atRuleBody(hero, '@container workspace-hero (width < 34rem)');
    // A compact horizontal strip, not the 12rem metric panel.
    expect(hero).toMatch(/\.workspace-hero__metrics\s*\{[^}]*flex-wrap:\s*nowrap[^}]*overflow-x:\s*auto/);
    expect(phone).toMatch(/\.workspace-hero__metrics\s*\{[^}]*padding-block:\s*1rem 1\.125rem/);
    // The mascot column is gone from the markup, so the stylesheet must not still be hiding one: a rule
    // for an element nobody renders is how a stylesheet keeps describing a page that no longer exists.
    expect(hero).not.toMatch(/\.workspace-hero__mascot|\.workspace-hero__body/);
    // Neither is the reserved height that made an empty title block cost a third of a phone screen.
    expect(hero).not.toMatch(/min-height:\s*8\.6rem/);
  });

  it('keeps one bottom hairline around an undivided, airy metric rail in both skins', () => {
    const hero = css('workspace-hero');
    const studio = readFileSync(resolve(process.cwd(), 'skins', 'studio', 'surfaces.css'), 'utf-8');
    expect(hero).toMatch(/\.workspace-hero\s*\{[^}]*border-bottom:\s*var\(--hairline\)/);
    expect(hero).not.toMatch(/\.workspace-hero__metrics\s*\{[^}]*border-(top|bottom|inline)/);
    expect(hero).not.toMatch(/\.workspace-metric\s*\{[^}]*border-inline-end/);
    expect(hero).toMatch(/\.workspace-hero__metrics\s*\{[^}]*gap:\s*clamp\([^}]*padding-block:\s*1\.125rem 1\.25rem/);
    expect(studio).toMatch(/\.workspace-hero__metrics\s*\{[^}]*flex-wrap:\s*nowrap[^}]*gap:\s*2rem[^}]*overflow-x:\s*auto/);
    expect(studio).toMatch(/\.workspace-metric\s*\{[^}]*border:\s*0/);
    // ORDER, not DOM order: the Studio skin makes the hero a flex column and gives the head `order: 2`,
    // so a rail left at the initial `order: 0` paints the figures above the name of the page.
    const railOrder = /\.workspace-hero__metrics\s*\{[^}]*order:\s*(\d+)/.exec(hero);
    expect(railOrder, 'the metric rail must state its order').not.toBeNull();
    const headOrder = /\.workspace-hero__head\s*\{[^}]*order:\s*(\d+)/.exec(studio);
    expect(headOrder, 'the Studio skin no longer orders the head — recheck the rail order').not.toBeNull();
    expect(Number(railOrder![1])).toBeGreaterThan(Number(headOrder![1]));
  });

  it('gives the page room below the top bar, and less of it in a narrow region', () => {
    const shell = css('workspace-shell');
    expect(shell).toMatch(/\.workspace-shell > \.workspace-hero,\s*\n\.workspace-page > \.workspace-hero,\s*\n\.workspace-page > \.workspace-page__lead > \.workspace-hero\s*\{\s*padding-block-start:\s*2rem/);
    const narrow = atRuleBody(shell, '@container workspace-shell (width < 34rem)');
    expect(narrow).toMatch(/padding-block-start:\s*1rem/);
    expect(narrow).toContain('.workspace-page > .workspace-page__lead > .workspace-hero');
    // The spacing reaches through the ONE named wrapper a page may put in front of its hero (the plugin
    // host's route entrance) and no further. A descendant combinator would also pad a hero a plugin
    // bundle mounts deep inside its own content, which is a different hero doing a different job.
    // Comments are stripped first — the rule's own note names that combinator to explain why it is wrong.
    expect(shell.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\.workspace-page \.workspace-hero/);
    // Padding rather than a margin: the shell declares no top padding of its own, so a margin on the
    // first child would collapse straight out through it.
    expect(shell).not.toMatch(/\.workspace-hero\s*\{[^}]*margin-block-start/);
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

  it('collapses the canonical toolbar row when its only child is the empty portal slot', () => {
    const toolbar = css('page-toolbar');
    expect(toolbar).toMatch(/\.page-toolbar:not\(:has\(\.page-toolbar__row > :not\(\.page-toolbar__slot:empty\)\)\)\s*\{\s*display:\s*none/);
  });

  it('strips the card chrome off a toolbar promoted into the row, and can only do so from below', () => {
    const toolbar = css('page-toolbar');
    expect(toolbar).toMatch(/\.page-toolbar__slot \.control-surface-toolbar,\s*\n\.page-toolbar__slot \.settings-toolbar\s*\{[^}]*background:\s*none/);
    // Same specificity as the rules it undoes, so ONLY the import order decides — see components.css.
    const order = readFileSync(resolve(process.cwd(), 'app', 'styles', 'components.css'), 'utf-8');
    const at = (part: string) => order.indexOf(`./components/${part}.css`);
    expect(at('page-toolbar')).toBeGreaterThan(at('workspace-hero'));
    expect(at('page-toolbar')).toBeGreaterThan(at('control-surface'));
    expect(at('page-toolbar')).toBeGreaterThan(at('spatial-deck'));
  });

  it('restores the sidebar grid, sticky scroll port and right-column containers', () => {
    const shellCss = css('workspace-shell');
    expect(shellCss).toMatch(/\[data-section-layout='sidebar'\]\s*\{[^}]*grid-template-columns:\s*minmax\(12rem, 14rem\) minmax\(0, 1fr\)[^}]*'hero hero'[^}]*'navigation toolbar'[^}]*'navigation content'/);
    expect(shellCss).toMatch(/\[data-section-layout='sidebar'\] > \.workspace-hero\s*\{[^}]*grid-area:\s*hero/);
    expect(shellCss).toMatch(/\[data-section-layout='sidebar'\] > \.workspace-shell__section-navigation\s*\{[^}]*position:\s*sticky[^}]*grid-area:\s*navigation[^}]*max-height:[^}]*overflow-y:\s*auto/);
    expect(shellCss).toMatch(/\[data-section-layout='sidebar'\] > \.page-toolbar\s*\{[^}]*container:\s*workspace-shell \/ inline-size[^}]*grid-area:\s*toolbar/);
    expect(shellCss).toMatch(/\.workspace-shell__content\s*\{[^}]*container:\s*workspace-shell \/ inline-size/);
    expect(shellCss).toMatch(/\[data-section-layout='sidebar'\] > \.workspace-shell__content\s*\{[^}]*grid-area:\s*content/);
    expect(shellCss).not.toContain("data-section-layout='select'");
  });

  it('clips tab wrappers while the inner segmented track owns horizontal scrolling and edge fades', () => {
    const shellCss = css('workspace-shell');
    expect(shellCss).toMatch(/\[data-layout='tabs'\]\s*\{[^}]*overflow:\s*hidden/);
    expect(shellCss).toMatch(/\.workspace-shell__section-navigation > \.segmented\s*\{[^}]*width:\s*100%/);
    const primitives = css('primitives');
    expect(primitives).toMatch(/\.segmented\[data-nowrap='true'\]\s*\{[^}]*mask-image:\s*linear-gradient/);
    expect(primitives).toContain('var(--segmented-edge-fade-left)');
    expect(primitives).toContain('var(--segmented-edge-fade-right)');
  });

  it('gives coarse-pointer section tabs a 44 by 44 minimum target', () => {
    const coarse = atRuleBody(css('workspace-shell'), '@media (pointer: coarse)');
    expect(coarse).toMatch(/\[data-layout='tabs'\] \.segmented__option\s*\{[^}]*min-width:\s*var\(--touch-target\)/);
    expect(coarse).toMatch(/\[data-layout='tabs'\] \.segmented__option\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
  });

  it('gives Studio a top-bar-aware neutral sidebar and keeps line tabs for phone/register', () => {
    const studio = readFileSync(resolve(process.cwd(), 'skins', 'studio', 'surfaces.css'), 'utf-8');
    expect(studio).toMatch(/\[data-section-layout='sidebar'\] > \.workspace-shell__section-navigation\s*\{[^}]*top:\s*calc\(var\(--studio-top-bar-height\) \+ 1rem\)[^}]*max-height:/);
    expect(studio).toContain(".workspace-shell__section-navigation[data-layout='sidebar'] .segmented__option");
    expect(studio).toMatch(/\[data-layout='sidebar'\] \.segmented__option\[aria-checked='true'\]\s*\{[^}]*color:\s*var\(--color-foreground\)[^}]*background:\s*var\(--studio-fill-active\)/);
    expect(studio).not.toContain(".workspace-shell__section-navigation[data-layout='select']");
    const tabBlock = studio.slice(studio.indexOf(".workspace-shell__section-navigation[data-layout='tabs']"));
    expect(tabBlock).toMatch(/\.segmented\s*\{[^}]*width:\s*100%/);
  });

  it('folds the narrow toolbar and keeps every part of it a touch target', () => {
    const toolbar = css('page-toolbar');
    const narrow = atRuleBody(toolbar, '@container workspace-shell (width < 34rem)');
    expect(narrow).toMatch(/\.page-toolbar__search\s*\{[^}]*flex-basis:\s*100%/);
    // A container query, never a viewport one: the same toolbar renders beside a pinned advisor dock.
    expect(toolbar.match(/@media \([^)]*width[^)]*\)/g)).toBeNull();
    const coarse = atRuleBody(toolbar, '@media (pointer: coarse)');
    // The chip is included because tapping it IS how a filter is removed.
    expect(coarse).toMatch(/\.page-filters__chip/);
    expect(coarse).toMatch(/min-height:\s*var\(--touch-target\)/);
  });
});
