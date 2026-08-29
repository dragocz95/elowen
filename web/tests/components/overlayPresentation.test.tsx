import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageProvider } from '../../lib/i18n';
import { Modal } from '../../components/ui/Modal';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { resolveOverlayPresentation } from '../../components/ui/overlayDepth';
import { PHONE_MAX_WIDTH } from '../../lib/breakpoints';

/** The overlay system, checked where it actually broke. Two thirds of this file is about a viewport
 *  jsdom cannot render: a media query, a container query and a safe-area inset are all invisible to it,
 *  and every one of the defects being pinned here lived exactly there. So the DOM contract (which
 *  presentation an overlay resolves to) is asserted against the components, and the geometry that
 *  presentation implies is asserted against the stylesheet that owns it. */

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const primitivesCss = readFileSync(join(WEB, 'app', 'styles', 'components', 'primitives.css'), 'utf-8');

/** Every file under `roots` whose name ends in one of `extensions`, as [repo-relative path, source]. */
function sources(roots: string[], extensions: string[]): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push([path.slice(WEB.length + 1), readFileSync(path, 'utf-8')]);
    }
  };
  for (const root of roots) walk(join(WEB, root));
  return out;
}

/** Everything the app renders, and every stylesheet that dresses it. Both guards below are whole-tree
 *  on purpose: the defects they pin were each introduced by one file that nobody thought to look at. */
const UI_SOURCES = sources(['components', 'modules'], ['.tsx', '.ts']);
const STYLESHEETS = sources(['app/styles', 'skins', 'modules'], ['.css']);

describe('the whole-tree guards below actually have a tree to walk', () => {
  // A guard that scans an empty corpus passes forever and proves nothing. This is what would notice a
  // directory being renamed out from under `sources()`.
  it('collected the app sources and the stylesheets', () => {
    expect(UI_SOURCES.length).toBeGreaterThan(100);
    expect(STYLESHEETS.length).toBeGreaterThan(10);
    // And the scanners recognise what they are looking for, so a green run means "none left", not
    // "pattern never matched anything".
    expect('max-h-[50vh]').toMatch(/\d(?:\.\d+)?vh\b/);
    expect('max-h-[50dvh]').not.toMatch(/\d(?:\.\d+)?vh\b/);
    expect([...'fixed z-[60] inset-0 z-30'.matchAll(/(?<![\w-])-?z-(?:\[(\d+)\]|(\d+))(?![\w.-])/g)]).toHaveLength(2);
    // The stylesheet half of the same guard, including the skins tree it now reads.
    expect(STYLESHEETS.some(([path]) => path.startsWith(join('skins', 'studio')))).toBe(true);
    expect([...'.a { z-index: 90; }'.matchAll(/z-index:\s*(\d+)/g)]).toHaveLength(1);
    expect([...'.a { z-index: var(--z-menu); }'.matchAll(/z-index:\s*(\d+)/g)]).toHaveLength(0);
  });
});

function W({ children }: { children: React.ReactNode }) { return <LanguageProvider>{children}</LanguageProvider>; }

/** Answer the phone media query the way a phone would. `useMobileViewport` is the single consumer of
 *  the breakpoint, so this is also what proves the two agree on where the boundary is. */
function asPhone(width = PHONE_MAX_WIDTH) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: /max-width:\s*(\d+)px/.test(query) && width <= Number(/max-width:\s*(\d+)px/.exec(query)![1]),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList);
}

afterEach(() => vi.restoreAllMocks());

describe('resolveOverlayPresentation', () => {
  it('keeps the drawer-then-window rule where there is room', () => {
    expect(resolveOverlayPresentation(0)).toBe('drawer');
    expect(resolveOverlayPresentation(1)).toBe('center');
    // Intent is a phone distinction only: with room, a rail and a dialog are the same shape.
    expect(resolveOverlayPresentation(0, 'roomy', 'inspect')).toBe('drawer');
  });

  it('uses the whole screen for every overlay on a phone', () => {
    expect(resolveOverlayPresentation(0, 'phone', 'inspect')).toBe('fullscreen');
    expect(resolveOverlayPresentation(0, 'phone', 'edit')).toBe('fullscreen');
    // Nothing nested: there is no room to show two layers, and a partial-height detail drawer hides the
    // content the user just opened behind a second scroll surface.
    expect(resolveOverlayPresentation(1, 'phone', 'inspect')).toBe('fullscreen');
    expect(resolveOverlayPresentation(2, 'phone', 'edit')).toBe('fullscreen');
  });
});

describe('overlays resolve against the live viewport', () => {
  it('opens a dialog as a drawer with room and as a fullscreen surface on a phone', () => {
    const { unmount } = render(<Modal title="Edit rule" onClose={vi.fn()}><span>body</span></Modal>, { wrapper: W });
    expect(screen.getByRole('dialog', { name: 'Edit rule' })).toHaveAttribute('data-presentation', 'drawer');
    unmount();

    asPhone();
    render(<Modal title="Edit rule" onClose={vi.fn()}><span>body</span></Modal>, { wrapper: W });
    const dialog = screen.getByRole('dialog', { name: 'Edit rule' });
    expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
    expect(dialog).toHaveClass('overlay-surface');
  });

  it('opens the detail rail fullscreen on a phone', () => {
    asPhone();
    render(
      <WorkspaceDetailRail label="Record" closeLabel="Close" onClose={vi.fn()}><span>detail</span></WorkspaceDetailRail>,
      { wrapper: W },
    );
    const rail = screen.getByRole('dialog', { name: 'Record' });
    expect(rail).toHaveAttribute('data-presentation', 'fullscreen');
    expect(rail).toHaveClass('overlay-surface');
  });

  it('honours an explicit presentation over the resolved one', () => {
    asPhone();
    render(<Modal title="Delete?" presentation="center" size="sm" onClose={vi.fn()}><span>sure?</span></Modal>, { wrapper: W });
    expect(screen.getByRole('dialog', { name: 'Delete?' })).toHaveAttribute('data-presentation', 'center');
  });
});

describe('overlay geometry', () => {
  it('measures every vertical length in dvh, everywhere', () => {
    // vh is the LARGE viewport height on a mobile browser: with the toolbar shown it is taller than the
    // screen, which is how a dialog's Save/Cancel row ended up under the browser chrome. Whole-tree,
    // because the same mistake is available in every component and every stylesheet; the allowlist below
    // is empty because nothing in this app wants a length that ignores the browser chrome.
    const VIEWPORT_STATIC_BY_DESIGN: string[] = [];
    const offenders: string[] = [];
    for (const [path, source] of [...UI_SOURCES, ...STYLESHEETS]) {
      if (VIEWPORT_STATIC_BY_DESIGN.includes(path)) continue;
      // `88dvh` cannot match: the `d` sits between the digits and the unit.
      for (const [match] of source.matchAll(/\d(?:\.\d+)?vh\b/g)) offenders.push(`${path}: ${match}`);
    }
    expect(offenders, 'vh is the large viewport height — use dvh').toEqual([]);
  });

  it('reads the safe-area insets through the tokens, in every stylesheet', () => {
    // tokens.css owns the four env() calls and nothing else may repeat them: a raw env() cannot be
    // overridden, cannot be tested and silently resolves to 0 wherever the fallback was forgotten.
    const offenders = STYLESHEETS
      .filter(([path]) => path !== join('app', 'styles', 'tokens.css'))
      .filter(([, source]) => source.includes('env(safe-area'))
      .map(([path]) => path);
    expect(offenders, 'safe-area insets come from var(--safe-*), which tokens.css defines').toEqual([]);
  });

  it('never names a floating layer with a literal z-index', () => {
    // The overlay scale starts at --z-fab (40). Below it a component is only ordering its OWN children
    // inside a stacking context it created, which is legitimate and stays out of this. At or above it a
    // literal is a claim about where the element sits among the app's drawers, dialogs, menus and
    // toasts — a claim only tokens.css is allowed to make.
    const OVERLAY_SCALE_FLOOR = 40;
    const offenders: string[] = [];
    for (const [path, source] of UI_SOURCES) {
      for (const [match, bracketed, plain] of source.matchAll(/(?<![\w-])-?z-(?:\[(\d+)\]|(\d+))(?![\w.-])/g)) {
        if (Number(bracketed ?? plain) >= OVERLAY_SCALE_FLOOR) offenders.push(`${path}: ${match}`);
      }
      for (const [match, value] of source.matchAll(/zIndex:\s*(\d+)/g)) {
        if (Number(value) >= OVERLAY_SCALE_FLOOR) offenders.push(`${path}: ${match}`);
      }
    }
    // Stylesheets too, and the skins among them. A skin is CODE with full reach over the app, and it is
    // where this exact defect already shipped once: `.studio-nav` claimed `z-index: 1` for every mode,
    // out-specified the `.overlay-layer-nav-drawer` class that assigns --z-nav-drawer (80), and put the
    // phone's whole menu underneath its own scrim. A skin writing `z-index: 90` instead would have been
    // just as invisible to a guard that only reads .tsx. Below the floor a rule is ordering its own
    // children inside a stacking context it created, which stays out of this as it does above.
    for (const [path, source] of STYLESHEETS) {
      for (const [match, value] of source.matchAll(/z-index:\s*(\d+)/g)) {
        if (Number(value) >= OVERLAY_SCALE_FLOOR) offenders.push(`${path}: ${match}`);
      }
    }
    expect(offenders, 'use an .overlay-layer-* class so the layer comes from the shared scale').toEqual([]);
  });

  it('places every floating layer on the shared z-index scale', () => {
    // A literal z-index is how the navigation drawer, the launcher, the toasts and the editor takeover
    // all ended up on 50 with their order decided by DOM position.
    for (const name of ['overlay-layer-nav-drawer', 'overlay-layer-drawer', 'overlay-layer-modal', 'overlay-layer-menu', 'overlay-toast-dock', 'overlay-fab']) {
      expect(primitivesCss, `.${name} must take its layer from the token scale`).toMatch(
        new RegExp(`\\.${name}\\b[^}]*z-index:\\s*var\\(--z-`),
      );
    }
    expect(primitivesCss.match(/z-index:\s*\d/), 'no overlay layer may carry a literal z-index').toBeNull();
  });

  it('insets every fixed overlay from the safe area', () => {
    // viewport-fit=cover is active, so anything pinned to an edge is under the notch or the home
    // indicator until it says otherwise. env() is never read directly: --safe-* is the one source.
    for (const name of ['overlay-toast-dock', 'overlay-fab', 'overlay-nav-drawer']) {
      const rule = new RegExp(`\\.${name}\\b[^}]*var\\(--safe-`);
      expect(primitivesCss, `.${name} must inset itself from the safe area`).toMatch(rule);
    }
    expect(primitivesCss).toContain('padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)');
  });

  it('keeps a sheet and a fullscreen surface apart where there is room', () => {
    // On a phone both take the width of the screen, which is right: there is one column and no page to
    // leave visible beside them. With room the phone geometry alone collapsed the two into the same
    // object — full bleed either way, 12dvh and half a rem apart — so `presentation="sheet"` and
    // `presentation="fullscreen"` opened surfaces nobody could tell apart. What separates them is that a
    // sheet stops being full-bleed: it takes a bounded width and centres itself over a page that stays
    // visible on both sides.
    const sheet = /@media \(min-width: 768px\)\s*\{\s*\.overlay-surface\[data-presentation='sheet'\]\s*\{([^}]*)\}/.exec(primitivesCss);
    expect(sheet, 'a sheet needs a geometry of its own above the phone breakpoint').not.toBeNull();
    expect(sheet![1], 'a full-bleed sheet is a fullscreen surface that stops short').toMatch(/width:\s*min\(/);
    expect(sheet![1], 'a surface pinned at both inline edges is centred by auto margins').toContain('margin-inline: auto');

    // And the other half of the pair stays full-bleed, so the two cannot be re-collapsed from the
    // fullscreen side by bounding it to the same width.
    const fullscreen = /@media \(min-width: 768px\)\s*\{\s*\.overlay-surface\[data-presentation='fullscreen'\]\s*\{([^}]*)\}/.exec(primitivesCss);
    expect(fullscreen, 'the fullscreen inset rule must stay').not.toBeNull();
    expect(fullscreen![1], 'a fullscreen surface is sized by its inset, never by a width').not.toMatch(/(?:^|[\s;])width:/);
  });

  it('guarantees the touch floor for a coarse pointer', () => {
    expect(primitivesCss).toMatch(/@media \(pointer: coarse\)[^}]*\{[\s\S]*?min-height: var\(--touch-target\)/);
  });
});
