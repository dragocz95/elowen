import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/** The two CLI chat knobs in Account → Terminal are clamped in THREE places at once, and all three have
 *  to agree. The daemon (`src/store/terminalSettings.ts`) decides which value survives a save; the web
 *  sliders must not offer one it would silently lower; and the CLI re-applies the same pair on what it
 *  receives, because an installed CLI talks to whatever daemon version is running — which is the one clamp
 *  a browser-only check could never stand in for. None of the three may import another (the web is barred
 *  from `src/` by dependency-cruiser's `web-not-to-backend` rule, and the CLI must not depend on the web),
 *  so the tables are compared as TEXT — reading a file is not a module dependency.
 *
 *  Defaults are pinned alongside the bounds: enabling a setting must not itself change behaviour, so the
 *  daemon default, the web seed and the CLI's offline fallback all have to stay on the old constant. */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const daemon = read('../../../../src/store/terminalSettings.ts');
const web = read('../../../modules/account/TerminalSection.tsx');
const webDefaults = read('../../../components/terminal/palettes.ts');
const cliHistory = read('../../../../src/cli/chat/promptHistory.ts');
const cliInterrupt = read('../../../../src/cli/chat/interruptLadder.ts');

/** Numeric literals may carry `_` separators on the daemon/CLI side. */
const num = (literal: string): number => Number(literal.replace(/_/g, ''));

/** A `[min: number, max: number]` bounds constant, resolved by name. Every one of the three sides writes
 *  the pair in this exact shape, which is what lets one reader compare them all. */
function bounds(source: string, name: string, label: string): [min: number, max: number] {
  const found = new RegExp(`const ${name}: \\[min: number, max: number\\] = \\[([\\d_]+), ([\\d_]+)\\];`).exec(source);
  expect(found, `${label}: ${name} not found in the shape this test compares`).toBeTruthy();
  return found ? [num(found[1]), num(found[2])] : [Number.NaN, Number.NaN];
}

/** A `name: 12_345,` field inside an object literal, or a `const NAME = 12_345;` declaration. */
function value(source: string, pattern: RegExp, label: string): number {
  const found = pattern.exec(source);
  expect(found, `${label} not found`).toBeTruthy();
  return found ? num(found[1]) : Number.NaN;
}

describe('CLI chat knobs — daemon clamp, web sliders and the CLI re-clamp', () => {
  it('bounds the prompt-history depth identically on all three sides', () => {
    const daemonBounds = bounds(daemon, 'PROMPT_HISTORY_DEPTH_BOUNDS', 'daemon');
    expect(bounds(web, 'PROMPT_HISTORY_DEPTH_BOUNDS', 'web')).toEqual(daemonBounds);
    expect(bounds(cliHistory, 'PROMPT_HISTORY_DEPTH_BOUNDS', 'cli')).toEqual(daemonBounds);
  });

  it('bounds the double-Esc window identically on all three sides', () => {
    const daemonBounds = bounds(daemon, 'INTERRUPT_CONFIRM_BOUNDS', 'daemon');
    expect(bounds(web, 'INTERRUPT_CONFIRM_BOUNDS', 'web')).toEqual(daemonBounds);
    expect(bounds(cliInterrupt, 'INTERRUPT_CONFIRM_BOUNDS', 'cli')).toEqual(daemonBounds);
  });

  it('keeps every default on the value that was hardcoded before the setting existed', () => {
    const depth = value(daemon, /promptHistoryDepth: ([\d_]+),/, 'daemon promptHistoryDepth default');
    const window = value(daemon, /interruptConfirmMs: ([\d_]+),/, 'daemon interruptConfirmMs default');
    expect(depth).toBe(100);  // MAX_PROMPT_HISTORY
    expect(window).toBe(1800); // INTERRUPT_CONFIRM_MS
    expect(value(webDefaults, /promptHistoryDepth: ([\d_]+),/, 'web promptHistoryDepth seed')).toBe(depth);
    expect(value(webDefaults, /interruptConfirmMs: ([\d_]+),/, 'web interruptConfirmMs seed')).toBe(window);
    expect(value(cliHistory, /export const MAX_PROMPT_HISTORY = ([\d_]+);/, 'CLI depth fallback')).toBe(depth);
    expect(value(cliInterrupt, /export const INTERRUPT_CONFIRM_MS = ([\d_]+);/, 'CLI window fallback')).toBe(window);
  });

  // Every default has to sit INSIDE its own clamp, or the very first save would move a value the user
  // never touched — the setting would change behaviour just by existing.
  it('leaves both defaults inside their bounds', () => {
    const [depthMin, depthMax] = bounds(daemon, 'PROMPT_HISTORY_DEPTH_BOUNDS', 'daemon');
    const [windowMin, windowMax] = bounds(daemon, 'INTERRUPT_CONFIRM_BOUNDS', 'daemon');
    expect(depthMin).toBeLessThanOrEqual(100);
    expect(depthMax).toBeGreaterThanOrEqual(100);
    expect(windowMin).toBeLessThanOrEqual(1800);
    expect(windowMax).toBeGreaterThanOrEqual(1800);
  });
});
