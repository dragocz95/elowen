import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { Bot, Server, Wrench } from 'lucide-react';
import { LanguageProvider } from '../../lib/i18n';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { WorkspaceMetric } from '../../components/ui/WorkspaceHero';
import { CompactWorkspaceHeader, SpatialWorkspaceLayout } from '../../components/ui/WorkspacePrimitives';
import { SpatialControlDeck } from '../../components/ui/SpatialControlDeck';

/** How much room the shell reports. The layout the section navigation takes is a function of MEASURED
 *  width, and jsdom lays nothing out — a real `ResizeObserver` would report 0 here forever, which is only
 *  ever the wide answer. Mocking the hook is what makes the narrow branch reachable at all.
 *
 *  0 is the default because it is the hook's own "not measured yet" contract and therefore what every
 *  case that is not about width should see. `vi.hoisted` is required: `vi.mock` is lifted above the
 *  imports, so a plain `const` would still be in its temporal dead zone when the factory runs. */
const shell = vi.hoisted(() => ({ width: 0 }));
vi.mock('../../lib/useElementWidth', () => ({
  useElementWidth: () => shell.width,
  useElementHeight: () => 0,
}));
afterEach(() => { shell.width = 0; });

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

/** ONE section model, three presentations, and the shell — not the page — decides which. A deck is a
 *  configuration surface with a long unordered set of sections, so with room it gets a column of its own
 *  and without room a single picker; a register's sections are a filter over one collection and stay a
 *  tab row at every width. None of it is a prop, which is the point: no call site and no plugin bundle
 *  changed to get it. */
describe('the section navigation takes its shape from the variant and the room the shell has', () => {
  const deck = (
    <LanguageProvider>
      <SpatialControlDeck eyebrow="Settings" ariaLabel="Settings sections" sections={sections} value="system" onChange={vi.fn()}>
        <div>Section</div>
      </SpatialControlDeck>
    </LanguageProvider>
  );

  it('gives a roomy deck a vertical section column, with a glyph on every row', () => {
    shell.width = 1_200;
    const { container } = render(deck);

    expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'sidebar');
    const nav = container.querySelector('.workspace-shell__section-navigation');
    expect(nav).toHaveAttribute('data-layout', 'sidebar');

    // Still one radiogroup with the same accessible name — a column is a presentation, not a different
    // control. `menu` is the shared Segmented's vertical variant, so the roving tab stop, the arrows and
    // aria-checked all come from the same place they do in a tab row.
    const group = screen.getByRole('radiogroup', { name: 'Settings sections' });
    expect(group).toHaveAttribute('data-variant', 'menu');
    expect(group).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.queryByRole('combobox')).toBeNull();
    // A row has a whole line to itself here, so the section's own glyph rides with its name. Counted as
    // a DIRECT child of each option: the checked row also mounts Radix's own (hidden) indicator glyph,
    // and counting every svg in the column would pass on that alone.
    const withGlyph = [...(nav?.querySelectorAll('.segmented__option') ?? [])]
      .filter((option) => option.querySelector(':scope > svg') !== null);
    expect(withGlyph).toHaveLength(sections.length);
  });

  it('folds a deck with no room for a column down to one picker, keeping the glyph and the count', () => {
    shell.width = 720;
    const { container } = render(
      <LanguageProvider>
        <SpatialControlDeck
          eyebrow="Settings"
          ariaLabel="Settings sections"
          sections={[{ ...sections[0]!, count: 3 }, sections[1]!]}
          value="system"
          onChange={vi.fn()}
        >
          <div>Section</div>
        </SpatialControlDeck>
      </LanguageProvider>,
    );

    expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'select');
    expect(container.querySelector('.workspace-shell__section-navigation')).toHaveAttribute('data-layout', 'select');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    const picker = screen.getByRole('combobox', { name: 'Settings sections' });
    // A picker has nowhere to put a figure beside a label, so the count folds INTO the label rather than
    // being dropped — a section that carries one on a desktop still carries it on a phone.
    expect(picker).toHaveTextContent('System (3)');
    expect(picker.querySelector('span[aria-hidden] > svg')).not.toBeNull();
  });

  it('opens on the column rather than the picker while the width is still unknown', () => {
    // `useElementWidth` reports 0 until its first observation. Reading that as narrow would paint the
    // phone picker for a frame on every desktop deck; reading it as wide is the safe first paint, and the
    // stylesheet carries the complementary phone guard.
    shell.width = 0;
    const { container } = render(deck);
    expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'sidebar');
  });

  it('keeps a register on horizontal tabs however much room it has', () => {
    for (const width of [0, 480, 1_600]) {
      shell.width = width;
      const { container, unmount } = render(
        <WorkspaceShell
          variant="register"
          hero={{ title: 'Memory', metrics: <WorkspaceMetric label="Active" value={4} /> }}
          navigation={{ sections, value: 'system', onChange: vi.fn(), ariaLabel: 'Sections' }}
        >
          <div>Register</div>
        </WorkspaceShell>,
      );

      expect(container.querySelector('.workspace-shell'), `${width}px`).toHaveAttribute('data-section-layout', 'tabs');
      const group = screen.getByRole('radiogroup', { name: 'Sections' });
      expect(group).toHaveAttribute('data-variant', 'line');
      expect(group, 'a tab row stays on one line and scrolls').toHaveAttribute('data-nowrap', 'true');
      expect(screen.queryByRole('combobox')).toBeNull();
      // And no glyphs: in a tab row an icon doubles the width of every label and buys nothing.
      expect(container.querySelectorAll('.workspace-shell__section-navigation .segmented__option > svg')).toHaveLength(0);
      unmount();
    }
  });

  it('states the same DOM anatomy in every layout, because the arrangement is a grid placement', () => {
    // The sidebar is laid out by `grid-area`, not by a different tree. A reader with no stylesheet, and a
    // screen reader following the document, meet the page in the order it is written — and that order is
    // the SAME order in all three layouts.
    const expected = ['workspace-hero', 'workspace-shell__section-navigation', 'page-toolbar', 'workspace-shell__content'];
    for (const width of [1_200, 720]) {
      shell.width = width;
      const { container, unmount } = render(deck);
      expect(anatomy(container.querySelector('.workspace-shell')), `${width}px`).toEqual(expected);
      unmount();
    }
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
    expect(phone).toMatch(/\.workspace-hero__metrics\s*\{[^}]*display:\s*flex/);
    expect(phone).toMatch(/\.workspace-metric\s*\{[^}]*padding:\s*0\.7rem/);
    // The mascot column is gone from the markup, so the stylesheet must not still be hiding one: a rule
    // for an element nobody renders is how a stylesheet keeps describing a page that no longer exists.
    expect(hero).not.toMatch(/\.workspace-hero__mascot|\.workspace-hero__body/);
    // Neither is the reserved height that made an empty title block cost a third of a phone screen.
    expect(hero).not.toMatch(/min-height:\s*8\.6rem/);
  });

  it('makes the metric rail one hairline under the heading, in that order under every design', () => {
    const hero = css('workspace-hero');
    expect(hero).toMatch(/\.workspace-hero__metrics\s*\{[^}]*border-top:\s*var\(--hairline\)/);
    // ORDER, not DOM order: the Studio skin makes the hero a flex column and gives the head `order: 2`,
    // so a rail left at the initial `order: 0` paints the figures above the name of the page.
    const railOrder = /\.workspace-hero__metrics\s*\{[^}]*order:\s*(\d+)/.exec(hero);
    expect(railOrder, 'the metric rail must state its order').not.toBeNull();
    const studio = readFileSync(resolve(process.cwd(), 'skins', 'studio', 'surfaces.css'), 'utf-8');
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

  it('measures a settings surface against the content column, not against the page', () => {
    // `@container workspace-shell` is what every settings record, control surface and toolbar folds
    // against. A container query resolves against the NEAREST named ancestor, so while the shell was the
    // only one, a record beside a 15rem section column asked how wide the whole PAGE is and answered by
    // the width of the column. The content column has to carry the name for the question to mean "how
    // much room does this surface have".
    const shellCss = css('workspace-shell');
    expect(shellCss).toMatch(/\.workspace-shell__content\s*\{[^}]*container:\s*workspace-shell \/ inline-size/);
    expect(shellCss).toMatch(/\.workspace-shell\[data-section-layout='sidebar'\] > \.page-toolbar\s*\{[^}]*container:\s*workspace-shell \/ inline-size/);
    // The shell keeps the name too for the hero and section column, which still measure the full page.
    expect(shellCss).toMatch(/\.workspace-shell,\s*\n\.workspace-page\s*\{[^}]*container:\s*workspace-shell \/ inline-size/);
  });

  it('places the deck column beside the surface it configures and parks it there', () => {
    const shellCss = css('workspace-shell');
    const sidebar = /\.workspace-shell\[data-section-layout='sidebar'\]\s*\{([^}]*)\}/.exec(shellCss);
    expect(sidebar, 'the sidebar layout must be laid out from one rule').not.toBeNull();
    expect(sidebar![1]).toMatch(/display:\s*grid/);
    // The hero names the PAGE and spans both columns; the section column spans the toolbar AND the
    // content, so it reads as one surface beside one working area rather than as a control above a card.
    expect(sidebar![1]).toMatch(/'hero hero'/);
    expect(sidebar![1]).toMatch(/'sections toolbar'/);
    expect(sidebar![1]).toMatch(/'sections content'/);
    // Every one of the four children is placed explicitly: a grid item left to auto-placement would move
    // the moment the anatomy gains a part.
    for (const area of ['hero', 'toolbar', 'content', 'sections']) {
      expect(shellCss, `nothing places the ${area} area`).toMatch(new RegExp(`grid-area:\\s*${area}`));
    }
    // `align-self: start` is what makes the sticky work: a stretched grid item is already as tall as its
    // containing block and has nowhere to move.
    const column = /\.workspace-shell\[data-section-layout='sidebar'\] > \.workspace-shell__section-navigation\s*\{([^}]*)\}/.exec(shellCss);
    expect(column).not.toBeNull();
    expect(column![1]).toMatch(/position:\s*sticky/);
    expect(column![1]).toMatch(/top:\s*var\(--section-sidebar-sticky-top\)/);
    expect(column![1]).toMatch(/align-self:\s*start/);
    expect(column![1]).toMatch(/max-height:\s*calc\(100dvh/);
    expect(column![1]).toMatch(/overflow-y:\s*auto/);
    // Three tokens, no literals: a design restates the width, the gap and the offset without touching a
    // grid template.
    const tokens = readFileSync(resolve(process.cwd(), 'app', 'styles', 'tokens.css'), 'utf-8');
    for (const token of ['--section-sidebar-width', '--section-sidebar-gap', '--section-sidebar-sticky-top']) {
      expect(tokens, `${token} is read but never declared`).toContain(`${token}:`);
      expect(shellCss).toContain(`var(${token})`);
    }
  });

  it('guards the phone against the wide first paint, from the viewport rather than the container', () => {
    // The shell reads an unmeasured width as wide, so a phone paints one frame of the two-column grid
    // before the observer fires. A container query cannot catch it — the shell IS the container being
    // laid out — and the viewport is known before any JavaScript runs. 48rem is the exact complement of
    // PHONE_MAX_WIDTH (767px, lib/breakpoints.ts).
    const phone = atRuleBody(css('workspace-shell'), '@media (width < 48rem)');
    expect(phone).toMatch(/\.workspace-shell\[data-section-layout='sidebar'\]\s*\{[^}]*display:\s*block/);
    expect(phone).toMatch(/position:\s*static/);
    expect(phone).toMatch(/\.segmented__option:not\(\[aria-checked='true'\]\)\s*\{[^}]*display:\s*none/);
    expect(phone).toMatch(/\.segmented__option\[aria-checked='true'\]\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
    const coarse = atRuleBody(css('workspace-shell'), '@media (pointer: coarse)');
    expect(coarse).toMatch(/\[data-layout='select'\] \[role='combobox'\]\s*\{[^}]*min-height:\s*var\(--touch-target\)/);
  });

  it('keeps the Studio tab treatment off the two layouts that are not a tab row', () => {
    const studio = readFileSync(resolve(process.cwd(), 'skins', 'studio', 'surfaces.css'), 'utf-8');
    // `width: fit-content`, `overflow: hidden` and a 2px bottom rule under every option are a treatment
    // for a HORIZONTAL TRACK. Unscoped they reached the deck's column and its picker too and undid both
    // one declaration at a time.
    const unscoped = studio
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => line.includes('.workspace-shell__section-navigation'))
      .filter((line) => !line.includes("[data-layout='"));
    expect(unscoped, 'a Studio rule still styles the navigation without naming a layout').toEqual([]);
    // And both non-tab layouts are actually spoken for, rather than merely excluded.
    expect(studio).toContain(".workspace-shell__section-navigation[data-layout='sidebar']");
    expect(studio).toContain(".workspace-shell__section-navigation[data-layout='select']");
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
