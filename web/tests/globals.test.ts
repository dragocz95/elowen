import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'styles');
const read = (path: string): string => readFileSync(path, 'utf-8');

const css = read(join(STYLES, 'tokens.css'));
const animations = read(join(STYLES, 'animations.css'));

/** The component stylesheet as the BROWSER sees it: components.css is an ordered @import list and
 *  postcss-import flattens it in place, so the shipped sheet is the concatenation of the parts in that
 *  order. Following the imports rather than naming the parts means a file split, a rename or a new part
 *  cannot quietly drop an assertion below into a stylesheet nobody reads. */
const components = [
  ...read(join(STYLES, 'components.css')).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@import\s+["']([^"']+)["']/g),
].map(([, target]) => read(resolve(STYLES, target!))).join('\n');

describe('design tokens', () => {
  it('defines the OLED Ember depth and motion tokens', () => {
    for (const t of ['--radius', '--radius-sm', '--radius-lg', '--text-display', '--text-caption', '--shadow-card', '--shadow-raised', '--shadow-ember', '--motion-fast', '--motion-base', '--motion-slow', '--ease-out']) {
      expect(css).toContain(t);
    }
  });

  it('has one dark palette and no light-theme override', () => {
    expect(css).toContain('--color-background: #000000');
    expect(css).not.toContain("data-theme='light'");
  });

  // Inter Variable is the app's ONE sans face, headings included. `--font-geist-sans` survives only as a
  // compatibility alias for plugin sheets compiled against an older kit: an undefined variable inside a
  // font-family list invalidates the whole declaration, so dropping the name outright would leave those
  // bundles in the browser default rather than falling back to Inter.
  it('resolves the whole sans ramp, headings included, to Inter Variable', () => {
    expect(css).toMatch(/--font-geist-sans:\s*"Inter Variable"/);
    expect(css).toContain('--font-sans: var(--font-geist-sans)');
    expect(css).toContain('--font-display: var(--font-sans)');
    // The heading token must not name a second face ahead of the body one — that split IS the bug this
    // replaced, where --font-display put Geist in front of Inter and headings alone changed face.
    expect(css).not.toMatch(/--font-display:[^;]*geist/);
  });

  // The reference design runs -0.16px at 16px and -0.13px at 13px, which is one ratio stated twice.
  it('tracks the UI face from a single ratio token', () => {
    expect(css).toContain('--tracking-ui: -0.01em');
  });

  // Geometry the sidebar primitive and the skin BOTH read. `--sidebar-width-icon` in particular is the
  // one upstream shadcn injects as an inline style; declared here it stays overridable by a skin.
  //
  // Every number is PINNED to the value measured off the reference dashboard, not merely asserted to
  // exist: these are the column's proportions, and a token that still exists with a different value is
  // exactly the change this file is here to catch. The rail is pinned for a second reason as well — both
  // Studio skins used to restate 57px, and the value now lives here alone.
  it('defines the sidebar geometry the navigation column is built on', () => {
    for (const token of [
      '--sidebar-width: 16.25rem',        // 260px, the expanded column
      '--sidebar-width-icon: 3.5625rem',  // 57px, the folded rail
      '--sidebar-width-mobile',
      '--sidebar-row-height: 2.125rem',   // 34px
      '--sidebar-row-radius: 0.5rem',     // 8px
      '--sidebar-sub-indent: 1.75rem',    // 28px
      '--sidebar-text: 0.8125rem',        // 13px
      '--sidebar-header-height: 3.625rem', // 58px
      '--sidebar-switcher-height: 2.5rem', // 40px, the switcher centred inside that header
      '--sidebar-footer-height: 3rem',    // 48px
      '--sidebar-search-height: 2rem',    // 32px
      '--sidebar-caret-motion: 200ms',    // the disclosure's own duration, not --motion-base
    ]) {
      expect(css).toContain(token);
    }
  });

  // The navigation header and the page's top bar are two halves of ONE frame line, so the height is a
  // single token read by both and the top bar states no number of its own. The alias is what the test
  // pins: a literal 3.625rem restated on the bar would pass every assertion here and still drift the
  // moment either side was retuned.
  it('drives the page top bar from the sidebar header height', () => {
    expect(css).toContain('--topbar-height: var(--sidebar-header-height)');
    expect(read(join(STYLES, '..', '..', 'components', 'shell', 'TopBar.tsx')))
      .toContain('h-[var(--topbar-height)]');
    // The Studio family follows the same token instead of its own measured strip.
    expect(read(join(STYLES, '..', '..', 'skins', 'studio', 'shared.css')))
      .toContain('--studio-top-bar-height: var(--topbar-height)');
  });

  // The two hairlines meet, so they are painted from ONE token. `--studio-line` and
  // `--color-sidebar-border` resolve differently in both Studio variants, which is what made the frame
  // line change colour halfway across the window.
  it('paints both halves of the frame hairline from the sidebar border token', () => {
    expect(components).toMatch(/\.sidebar-nav__header\s*\{[^}]*border-bottom:\s*1px solid var\(--color-sidebar-border\)/);
    expect(read(join(STYLES, '..', '..', 'components', 'shell', 'TopBar.tsx')))
      .toContain('border-b border-sidebar-border');
    expect(read(join(STYLES, '..', '..', 'skins', 'studio', 'surfaces.css')))
      .toMatch(/\.top-bar--bar\s*\{[^}]*border-bottom-color:\s*var\(--color-sidebar-border\)/);
  });

  // The header is a ROW, and it says so: the shadcn primitive ships `flex flex-col`, so a header that
  // only set `align-items: center` left the switcher pinned to the top edge of a 58px box.
  it('centres the instance switcher in the navigation header', () => {
    expect(components).toMatch(
      /\.sidebar-nav__header\s*\{[^}]*flex-direction:\s*row;[^}]*align-items:\s*center;[^}]*height:\s*var\(--sidebar-header-height\);[^}]*padding-block:\s*0/,
    );
    expect(components).toMatch(/\.sidebar-nav__switcher\s*\{[^}]*min-height:\s*var\(--sidebar-switcher-height\)/);
    // The lockup carries the header: 28px mark, 17px wordmark, and the build stays the caption step
    // beside them rather than growing with the name.
    expect(components).toMatch(/\.sidebar-nav__mark\s*\{[^}]*width:\s*1\.75rem;\s*height:\s*1\.75rem/);
    expect(components).toMatch(/\.sidebar-nav__brand\s*\{[^}]*font-size:\s*1\.0625rem;[^}]*font-weight:\s*600/);
    expect(components).toMatch(/\.sidebar-nav__version\s*\{[^}]*font-size:\s*var\(--text-caption\)/);
  });

  // The column is framed on its outer edge by the SAME hairline the top bar draws, so the two are one
  // frame turning a corner (owner decision, 6 Sep 2026, overriding the transparent edge of 5 Sep). The
  // rule keeps a token name of its own — a design may still want the column to melt into the canvas —
  // but that token must RESOLVE to `--color-sidebar-border`, or the vertical line and the horizontal one
  // drift apart in colour again. The border sits on the column itself, which is what runs it the full
  // height, header and footer included, and keeps it on the folded rail.
  it('draws the outer rule down the navigation column in the frame hairline', () => {
    expect(css).toContain('--color-sidebar-rule: var(--color-sidebar-border)');
    expect(components).toMatch(/\.sidebar-nav\[data-side='left'\]\s*\{\s*border-right:\s*1px solid var\(--color-sidebar-rule\)/);
    expect(components).toMatch(/\.sidebar-nav\[data-side='right'\]\s*\{\s*border-left:\s*1px solid var\(--color-sidebar-rule\)/);
    // Neither Studio skin may pin the outer edge back to a colour of its own.
    for (const skin of ['studio-light', 'studio-oled']) {
      expect(read(join(STYLES, '..', '..', 'skins', skin, 'skin.css'))).not.toContain('--color-sidebar-rule:');
    }
  });

  // Inside the column a group is introduced by its LABEL and by the air the label carries — 16px above,
  // 8px below — and by nothing else. The menu draws NO hairline at all, and the account has no region of
  // its own any more (owner, 7 Sep 2026): a rule addressing one is the regression to catch.
  it('separates groups by their label alone, drawing no hairline in the menu', () => {
    expect(components).not.toMatch(/\.sidebar-nav__group \+ \.sidebar-nav__group\s*\{[^}]*border-top/);
    expect(components).toMatch(/\.sidebar-nav__group-label\s*\{[^}]*margin:\s*1rem 0 0\.5rem/);
    expect(components).not.toContain('sidebar-nav__separator');
    expect(components).not.toContain("[data-group='account']");
  });

  // The rows' entrance animation fills `both`, which keeps its final transform applied and outranks the
  // inline transform a drag writes. Dropping this rule is how dragging silently stops moving anything.
  it('switches the row entrance animation off while a row is being dragged', () => {
    expect(components).toMatch(/\.sidebar-nav\[data-drag\] \.sidebar-nav__entry\s*\{[^}]*animation:\s*none/);
  });

  // The quick-search field is a white shape inside a light hairline at the row radius. Both halves are
  // load-bearing: the fill must not be the canvas the column itself is grounded on, or the field is an
  // outline around nothing, and the edge is the reference's own.
  it('draws the quick-search field as a filled shape with a hairline edge', () => {
    expect(components).toMatch(
      /\.sidebar-nav__search-field\s*\{[^}]*border:\s*1px solid var\(--color-sidebar-border\);[^}]*background:\s*var\(--color-card\)/,
    );
  });

  it('uses one account-dark token for shared document surfaces', () => {
    expect(css).toContain('--color-document: #030303');
    expect(components).toMatch(/\.control-surface-document\s*\{[^}]*background:[^;}]*var\(--color-document\)/);
  });

  it('collapses the hero metrics into a compact strip in a narrow hero', () => {
    // The metric row is the hero's heaviest block, and at phone width a multi-column grid of it pushed
    // the first record of the register roughly two screens down. It becomes ONE horizontally scrolling
    // strip instead. The query is the hero's own NAMED container, never the viewport: the same hero is
    // rendered beside a pinned dock and inside a rail, where the window width says nothing useful.
    expect(components).toMatch(
      /\.workspace-hero__metrics\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto/,
    );
    expect(components).toMatch(
      /@container workspace-hero \(width < 34rem\)[\s\S]*?\.workspace-hero__metrics\s*\{[^}]*gap:\s*1\.25rem/,
    );
  });

  // The dashboard's metric strip hides the native scrollbar, so the fade is the only cue left that a
  // figure continues past the edge. Both halves belong to the same rule: hiding the bar without the mask
  // is the phone bug this replaced.
  it('hides the metric strip scrollbar only together with its measured edge fade', () => {
    expect(components).toMatch(/\.dash-strip\s*\{[^}]*scrollbar-width:\s*none;[^}]*mask-image:\s*linear-gradient/);
    expect(components).toMatch(/\.dash-strip\s*\{[^}]*--dash-strip-fade-left:\s*0px;[^}]*--dash-strip-fade-right:\s*0px;/);
    expect(components).toContain('.dash-strip::-webkit-scrollbar { display: none; }');
  });

  it('uses component width for spatial deck layout changes', () => {
    // The deck's label/control record stacks on the SHELL's width, not the window's: the same form is
    // rendered inside a detail rail, where a viewport media query would keep it in three tracks.
    expect(components).toMatch(/@container workspace-shell \(width < 38\.75rem\)[\s\S]*\.settings-row\s*\{[^}]*grid-template-columns:\s*1fr/);
    // The horizontal section rail that used to fold at 56.25rem is gone with the deck navigation itself:
    // a deck's sections are rows of the sidebar's sub-menu, so the page has no second menu to make
    // responsive, and a stylesheet still folding one would be describing a page nobody renders.
    expect(components).not.toContain('spatial-section-rail');
  });

  it('carries no hand-rolled telemetry scroll box now that the rail scrolls on ScrollArea', () => {
    // The rail's middle band is a Radix ScrollArea, which draws (and hides) its own scrollbar inside its
    // own DOM. The class that used to suppress the native bar has no element left to sit on, and a rule
    // matching nothing is how a stylesheet accumulates fiction.
    expect(components).not.toContain('telemetry-rail-scroll');
  });

  it('contains no orphaned redesign visuals, undefined motion token or obsolete detail grid overrides', () => {
    for (const legacy of ['.living-surface', '.ember-wash', '.hero-clock', '.status-orb', '.orbit-scroll-arrow', '.scrollbar-none']) {
      expect(components).not.toContain(legacy);
    }
    expect(components).not.toContain('--motion-normal');
    expect(components).not.toContain("[data-detail='true']");
    expect(css).not.toContain('--ambient-accent');
    expect(css).not.toContain('--ambient-warm');
    for (const legacy of ['.animate-route', '.animate-ambient', '@keyframes ambient-drift', '@keyframes ember-breathe', '@keyframes orbit-scroll-cue']) {
      expect(animations).not.toContain(legacy);
    }
  });

  it('caps the static mascot at the WebGL scene art size', () => {
    expect(components).toMatch(/\.spatial-mascot-fallback img\s*\{[^}]*width:\s*min\(58%,\s*11\.25rem\)/);
  });
});
