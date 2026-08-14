import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs plugin module, no types
import { observesLiveEvents, resolveDisplaySettings } from '../../packages/plugin-shared/display.mjs';

describe('observesLiveEvents', () => {
  it('is true whenever the surface renders tool activity', () => {
    expect(observesLiveEvents({ toolActivity: 'status', answerMode: 'final' }, {})).toBe(true);
    expect(observesLiveEvents({ toolActivity: 'live', answerMode: 'final' }, {})).toBe(true);
  });

  it('is true for a live answer even with tool activity off', () => {
    expect(observesLiveEvents({ toolActivity: 'off', answerMode: 'live' }, {})).toBe(true);
  });

  it('is true when reasoning is shown, whatever the display policy says', () => {
    expect(observesLiveEvents({ toolActivity: 'off', answerMode: 'final' }, { showReasoning: true })).toBe(true);
  });

  it('is false only when nothing on the surface would render a live event', () => {
    expect(observesLiveEvents({ toolActivity: 'off', answerMode: 'final' }, {})).toBe(false);
    // showReasoning is a strict flag: only a literal true opens a live message.
    expect(observesLiveEvents({ toolActivity: 'off', answerMode: 'final' }, { showReasoning: 'yes' })).toBe(false);
  });

  it('agrees with the resolved display policy for the default config', () => {
    // Default config is toolActivity 'status' → the turn still needs a live stream.
    expect(observesLiveEvents(resolveDisplaySettings({}), {})).toBe(true);
    // The legacy streaming:false install is the one that opts out entirely.
    expect(observesLiveEvents(resolveDisplaySettings({ streaming: false }), { streaming: false })).toBe(false);
  });
});
