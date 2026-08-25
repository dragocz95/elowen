import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/** The canonical limits table is `src/store/configStore.ts`: its defaults seed the form and its clamp
 *  bounds decide which values survive a save. `BrainLimitsModal` mirrors both, and the web may not IMPORT
 *  the daemon (dependency-cruiser's `web-not-to-backend` rule), so the two are compared as TEXT — reading a
 *  file is not a module dependency. Without this, a bound raised on one side only leaves the slider offering
 *  a value the daemon silently lowers, which is exactly the drift this pair last shipped with. */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const daemon = read('../../../../src/store/configStore.ts');
const web = read('../../../modules/settings/BrainLimitsModal.tsx');

/** Numeric literals are written with `_` separators on the daemon side. */
const num = (literal: string): number => Number(literal.replace(/_/g, ''));

/** The text of one `const NAME … = { … };` object literal. */
function objectBlock(source: string, marker: string, label: string): string {
  const start = source.indexOf(marker);
  expect(start, `${label} not found`).toBeGreaterThan(-1);
  const end = source.indexOf('\n};', start);
  expect(end, `${label} is not a closed object literal`).toBeGreaterThan(start);
  return source.slice(start + marker.length, end);
}

function numericFields(block: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [, key, value] of block.matchAll(/(\w+):\s*([\d_]+),/g)) out[key] = num(value);
  return out;
}

const daemonDefaults = numericFields(objectBlock(daemon, 'export const DEFAULT_BRAIN_LIMITS: BrainLimits = {', 'DEFAULT_BRAIN_LIMITS'));
const webDefaults = numericFields(objectBlock(web, 'export const BRAIN_LIMIT_DEFAULTS: BrainLimits = {', 'BRAIN_LIMIT_DEFAULTS'));
const boundsBlock = objectBlock(daemon, 'const BRAIN_LIMIT_BOUNDS: Record<keyof BrainLimits, [min: number, max: number]> = {', 'BRAIN_LIMIT_BOUNDS');

/** The daemon derives a tuning knob's bound from its default instead of writing both numbers by hand, so
 *  the expected bound has to be derived here too. The rule is pinned as TEXT first: were the arithmetic to
 *  change, this fails loudly rather than leaving the test computing a bound the daemon no longer applies. */
function daemonBandRule(): { minOf: (def: number) => number; maxOf: (def: number) => number } {
  const band = /const band = \(key: keyof BrainLimits, maxOverride\?: number\)[^}]+}/.exec(daemon)?.[0] ?? '';
  expect(band, 'the band() helper is not in the shape this test derives bounds from').toContain('Math.round(def / 2)');
  expect(band).toContain('maxOverride ?? Math.round(def * 1.5)');
  return { minOf: (def) => Math.round(def / 2), maxOf: (def) => Math.round(def * 1.5) };
}

function daemonBounds(): Record<string, [min: number, max: number]> {
  const { minOf, maxOf } = daemonBandRule();
  const out: Record<string, [number, number]> = {};
  for (const [, key, expression] of boundsBlock.matchAll(/^ {2}(\w+): (.+),$/gm)) {
    const explicit = /^\[([\d_]+), ([\d_]+)\]$/.exec(expression);
    if (explicit) { out[key] = [num(explicit[1]), num(explicit[2])]; continue; }
    const banded = new RegExp(`^band\\('${key}'(?:, ([\\d_]+))?\\)$`).exec(expression);
    expect(banded, `unrecognised bound expression for ${key}: ${expression}`).toBeTruthy();
    const def = daemonDefaults[key];
    expect(def, `${key} has a bound but no default`).toBeTypeOf('number');
    out[key] = [minOf(def!), banded?.[1] ? num(banded[1]) : maxOf(def!)];
  }
  return out;
}

function webBounds(): Record<string, [min: number, max: number]> {
  const out: Record<string, [number, number]> = {};
  for (const [, key, min, max] of web.matchAll(/\{ key: '(\w+)', kind: '\w+', min: (\d+), max: (\d+),/g)) {
    out[key] = [Number(min), Number(max)];
  }
  return out;
}

describe('brain limits — web editor against the daemon clamp', () => {
  it('offers exactly the daemon fields, no more and no fewer', () => {
    expect(Object.keys(webBounds()).sort()).toEqual(Object.keys(daemonBounds()).sort());
    expect(Object.keys(webDefaults).sort()).toEqual(Object.keys(daemonDefaults).sort());
  });

  it('bounds every slider to the daemon clamp bound', () => {
    expect(webBounds()).toEqual(daemonBounds());
  });

  it('seeds the form with the daemon defaults', () => {
    expect(webDefaults).toEqual(daemonDefaults);
  });

  // Guards the parsing itself: were a regex to stop matching, every table above would silently be empty
  // and all three assertions would pass on nothing.
  it('actually read both tables', () => {
    expect(Object.keys(daemonBounds())).toHaveLength(15);
    expect(Object.keys(webBounds())).toHaveLength(15);
    expect(daemonBounds().delegateContextChars).toEqual([20000, 80000]);
    expect(daemonBounds().elicitationTimeoutMs).toEqual([30000, 21600000]);
    expect(webBounds().toolOutputMaxChars).toEqual([20500, 80000]);
    expect(webDefaults.toolOutputMaxChars).toBe(41000);
  });
});
