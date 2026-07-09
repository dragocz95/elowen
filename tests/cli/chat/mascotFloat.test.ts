import { describe, expect, it } from 'vitest';
import { FLOAT_BAND, MascotFloat } from '../../../src/cli/chat/mascotFloat.js';

/** Drive the spring for up to `maxTicks` 33ms frames, collecting every sampled offset, and report where
 *  it settled (or -1 if it never did). */
function run(float: MascotFloat, maxTicks = 300): { samples: number[]; settledAt: number } {
  const samples: number[] = [];
  let settledAt = -1;
  for (let i = 0; i < maxTicks; i++) {
    float.tick(33);
    samples.push(float.value());
    if (float.settled()) { settledAt = i; break; }
  }
  return { samples, settledAt };
}

describe('MascotFloat spring model', () => {
  it('starts at rest and reports settled', () => {
    const float = new MascotFloat();
    expect(float.value()).toBe(0);
    expect(float.settled()).toBe(true);
  });

  it('drifts up on a positive impulse, then eases back and settles at exactly 0', () => {
    const float = new MascotFloat();
    float.impulse(1);
    const { samples, settledAt } = run(float);
    const peak = Math.max(...samples);
    // A single scroll must peak enough to shift at least one whole render row (round(offset) ≥ 1) …
    expect(peak).toBeGreaterThanOrEqual(0.5);
    // … yet never leave its reserved band …
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(FLOAT_BAND);
    // … and it comes to rest at exactly 0 within a bounded number of frames (idle CPU can then stop).
    expect(settledAt).toBeGreaterThan(0);
    expect(settledAt).toBeLessThan(200);
    expect(float.value()).toBe(0);
  });

  it('drifts the other way on a negative impulse', () => {
    const float = new MascotFloat();
    float.impulse(-1);
    const { samples } = run(float);
    expect(Math.min(...samples)).toBeLessThanOrEqual(-0.5);
    expect(Math.min(...samples.map((s) => s))).toBeGreaterThanOrEqual(-FLOAT_BAND);
    expect(float.value()).toBe(0);
  });

  it('clamps a huge burst within the band and still settles to 0', () => {
    const float = new MascotFloat();
    float.impulse(50); // absurdly large kick
    const { samples, settledAt } = run(float);
    expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(FLOAT_BAND);
    expect(settledAt).toBeGreaterThan(0);
    expect(float.value()).toBe(0);
  });

  it('accumulates rapid scrolls but stays clamped to the band', () => {
    const float = new MascotFloat();
    for (let i = 0; i < 6; i++) float.impulse(1); // a fast scroll burst before the spring can decay
    const { samples } = run(float);
    const peak = Math.max(...samples);
    expect(peak).toBeGreaterThan(1); // a burst pushes further than a single notch
    expect(peak).toBeLessThanOrEqual(FLOAT_BAND); // but never past the band edge
  });

  it('treats a zero impulse as a no-op', () => {
    const float = new MascotFloat();
    float.impulse(0);
    expect(float.value()).toBe(0);
    expect(float.settled()).toBe(true);
  });

  it('reset snaps an in-flight drift back to rest', () => {
    const float = new MascotFloat();
    float.impulse(1);
    float.tick(33);
    float.tick(33);
    expect(float.value()).not.toBe(0);
    float.reset();
    expect(float.value()).toBe(0);
    expect(float.settled()).toBe(true);
  });
});
