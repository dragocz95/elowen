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
    expect(css).toContain('--font-sans: var(--font-geist-sans)');
    expect(css).not.toContain("data-theme='light'");
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

  it('uses component width for spatial deck layout changes', () => {
    expect(components).toMatch(/@container workspace-shell \(width < 56\.25rem\)[\s\S]*\.spatial-section-rail__track/);
    // The deck's label/control record stacks on the SHELL's width, not the window's: the same form is
    // rendered inside a detail rail, where a viewport media query would keep it in three tracks.
    expect(components).toMatch(/@container workspace-shell \(width < 38\.75rem\)[\s\S]*\.settings-row\s*\{[^}]*grid-template-columns:\s*1fr/);
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
