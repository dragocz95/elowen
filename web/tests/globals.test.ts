import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'styles', 'tokens.css'), 'utf-8');
const components = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'styles', 'components.css'), 'utf-8');
const animations = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'styles', 'animations.css'), 'utf-8');

describe('design tokens', () => {
  it('defines the OLED Ember depth and motion tokens', () => {
    for (const t of ['--radius', '--radius-sm', '--radius-lg', '--text-display', '--text-caption', '--shadow-card', '--shadow-raised', '--shadow-ember', '--motion-fast', '--motion-base', '--motion-slow', '--ease-out']) {
      expect(css).toContain(t);
    }
  });

  it('has one dark palette and no light-theme override', () => {
    expect(css).toContain('--color-bg: #000000');
    expect(css).toContain('--font-sans: var(--font-geist-sans)');
    expect(css).not.toContain("data-theme='light'");
  });

  it('uses one account-dark token for shared document surfaces', () => {
    expect(css).toContain('--color-document: #030303');
    expect(components).toMatch(/\.control-surface-document\s*\{[^}]*background:[^;}]*var\(--color-document\)/);
  });

  it('stacks spatial hero metrics into a readable mobile grid', () => {
    expect(components).toMatch(/@container \(max-width: 38\.75rem\)[\s\S]*\.spatial-workspace-hero__metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('uses component width for spatial deck layout changes', () => {
    expect(components).toMatch(/@container \(max-width: 56\.25rem\)[\s\S]*\.spatial-deck-hero/);
    expect(components).toMatch(/@container \(max-width: 38\.75rem\)[\s\S]*\.spatial-form-row/);
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
