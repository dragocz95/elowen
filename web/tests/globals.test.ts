import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'styles', 'tokens.css'), 'utf-8');
const components = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'styles', 'components.css'), 'utf-8');

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
    expect(components).toMatch(/@media \(max-width: 620px\)[\s\S]*\.spatial-workspace-hero__metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  });

  it('caps the static mascot at the WebGL scene art size', () => {
    expect(components).toMatch(/\.spatial-mascot-fallback img\s*\{[^}]*width:\s*min\(58%,\s*11\.25rem\)/);
  });
});
