import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MIN_SILENCE_LIMIT_MS } from '../../../lib/streamWatchdog';

/** The runtime-knob twin of `brainLimitsParity.test.ts`: the canonical table is `src/store/configStore.ts`
 *  (its defaults seed the form, its clamp bounds decide which values survive a save), `RuntimeLimitsModal`
 *  mirrors both, and the web may not IMPORT the daemon (dependency-cruiser's `web-not-to-backend` rule) —
 *  so the two are compared as TEXT. Without this, a bound raised on one side only leaves the slider
 *  offering a value the daemon silently lowers. */
const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');
const daemon = read('../../../../src/store/configStore.ts');
const web = read('../../../modules/settings/RuntimeLimitsModal.tsx');

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

const daemonDefaults = numericFields(objectBlock(daemon, 'const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {', 'DEFAULT_RUNTIME_LIMITS'));
const webDefaults = numericFields(objectBlock(web, 'export const RUNTIME_LIMIT_DEFAULTS: RuntimeLimits = {', 'RUNTIME_LIMIT_DEFAULTS'));
const boundsBlock = objectBlock(daemon, 'const RUNTIME_LIMIT_BOUNDS: Record<keyof RuntimeLimits, [min: number, max: number]> = {', 'RUNTIME_LIMIT_BOUNDS');

/** A daemon-side `const NAME = 12_345;`, resolved by name — a bound may be written as a shared constant
 *  where two knobs genuinely share one edge (the stream silence pair and their heartbeat floor). */
function daemonConst(name: string): number {
  const found = new RegExp(`const ${name} = ([\\d_]+);`).exec(daemon);
  expect(found, `daemon constant ${name} not found`).toBeTruthy();
  return found ? num(found[1]) : Number.NaN;
}

/** Every runtime bound is written out explicitly (no `band()` derivation, unlike the brain limits) or as a
 *  named constant of this same file, so an entry neither regex can read is a real drift signal rather than
 *  an unsupported expression. */
function daemonBounds(): Record<string, [min: number, max: number]> {
  const out: Record<string, [number, number]> = {};
  const edge = (token: string): number => (/^[\d_]+$/.test(token) ? num(token) : daemonConst(token));
  for (const [, key, expression] of boundsBlock.matchAll(/^ {2}(\w+): (.+),$/gm)) {
    const explicit = /^\[([\w]+), ([\w]+)\]$/.exec(expression);
    expect(explicit, `unrecognised bound expression for ${key}: ${expression}`).toBeTruthy();
    if (explicit) out[key] = [edge(explicit[1]), edge(explicit[2])];
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

describe('runtime limits — web editor against the daemon clamp', () => {
  it('offers every runtime field except the threshold owned by Tool loading', () => {
    expect(Object.keys(webBounds()).sort()).toEqual(Object.keys(daemonBounds()).filter((key) => key !== 'toolDeferThreshold').sort());
    expect(Object.keys(webDefaults).sort()).toEqual(Object.keys(daemonDefaults).sort());
  });

  it('bounds every runtime slider to its daemon clamp bound', () => {
    const { toolDeferThreshold: _toolDeferThreshold, ...runtimeBounds } = daemonBounds();
    expect(webBounds()).toEqual(runtimeBounds);
  });

  it('seeds the form with the daemon defaults', () => {
    expect(webDefaults).toEqual(daemonDefaults);
  });

  // The stream watchdog runs in the BROWSER off a value the daemon serves, so its floor lives in three
  // places at once. A limit under the daemon's 30 s heartbeat would tear down a live but idle stream, so
  // all three have to agree — including the client-side re-clamp, which is the only one that still applies
  // when the config comes from a daemon of another version.
  it('floors both halves of the stream pair at the client-side heartbeat guard', () => {
    const bounds = daemonBounds();
    expect(bounds.streamSilenceLimitMs[0]).toBe(MIN_SILENCE_LIMIT_MS);
    expect(bounds.streamReviveSilenceLimitMs[0]).toBe(MIN_SILENCE_LIMIT_MS);
    expect(MIN_SILENCE_LIMIT_MS).toBeGreaterThan(30_000);
  });

  // Guards the parsing itself: were a regex to stop matching, every table above would silently be empty
  // and all three assertions would pass on nothing.
  it('actually read both tables', () => {
    expect(Object.keys(daemonBounds())).toHaveLength(13);
    expect(Object.keys(webBounds())).toHaveLength(12);
    expect(daemonBounds().localShellTimeoutMs).toEqual([10000, 300000]);
    expect(daemonBounds().memorySemanticFloorPerMille).toEqual([100, 800]);
    expect(webBounds().eventRetentionDays).toEqual([1, 365]);
    expect(webDefaults.memorySemanticFloorPerMille).toBe(200);
  });

  // The two score weights are the one group where a bound is a CORRECTNESS limit, not taste: semantic
  // similarity takes whatever they leave, so a pair that could sum past 1000 would drive it negative.
  it('caps the score weights so semantic similarity keeps at least 40% of the ranking', () => {
    const bounds = daemonBounds();
    const maxImportance = bounds.memoryImportanceWeightPerMille[1];
    const maxVitality = bounds.memoryVitalityWeightPerMille[1];
    expect(maxImportance + maxVitality).toBeLessThanOrEqual(600);
    expect(bounds.memoryImportanceWeightPerMille[0]).toBe(0);
    expect(bounds.memoryVitalityWeightPerMille[0]).toBe(0);
    expect(webDefaults.memoryImportanceWeightPerMille + webDefaults.memoryVitalityWeightPerMille).toBe(200);
  });

  // Both dedup thresholds were once set above every cosine the store can produce, so neither ever fired.
  // A ceiling at or above 1.0 would allow exactly that state again through the UI.
  it('keeps both dedup thresholds inside a range where they can actually fire', () => {
    const bounds = daemonBounds();
    for (const key of ['memoryDuplicatePerMille', 'memoryParaphrasePerMille'] as const) {
      expect(bounds[key][0]).toBeGreaterThanOrEqual(500);
      expect(bounds[key][1]).toBeLessThan(1000);
    }
    // Saving is the destructive side (it overwrites a stored memory), so it stays the stricter of the two.
    expect(webDefaults.memoryDuplicatePerMille).toBeGreaterThan(webDefaults.memoryParaphrasePerMille);
  });
});
