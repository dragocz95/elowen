import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { TelemetryPanel, type TelemetryState } from '../../../src/cli/chat/telemetryPanel.js';
import { chatTheme } from '../../../src/cli/chat/theme.js';

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const stateAt = (percent: number | null): TelemetryState => ({
  usage: percent == null ? null : { tokens: 10, contextWindow: 100, percent, totalTokens: 20, cost: 0 },
  cwd: '~/elowen',
  branch: 'main',
  mcp: null,
  lspEnabled: null,
  processes: [],
  subagents: [],
  rateLimits: null,
  goal: null,
  floatOffset: 0,
});

/** The Context meter row is the only bracketed frame (the flame logo uses ▀▄ half-blocks). */
const meterRow = (percent: number, width = 36): string =>
  new TelemetryPanel(() => stateAt(percent)).render(width).find((line) => /\[[▰ ]*\]/.test(strip(line)))!;

/** The `[ … ]` frame segment of a rendered meter row, stripped of colour. */
const frame = (percent: number, width = 36): string => strip(meterRow(percent, width)).match(/\[[▰ ]*\]/)![0];
const lit = (percent: number, width = 36): number => (frame(percent, width).match(/▰/g) ?? []).length;

describe('the usage meter', () => {
  it('frames the panel minus equal margins at any width', () => {
    for (const width of [36, 40, 46, 60]) {
      for (const percent of [0, 10, 33, 50, 75, 100]) {
        // Two frame cells plus the inner track fill the width minus a 2-column margin on each side.
        expect(frame(percent, width).length, `${percent}% @ ${width}`).toBe(width - 4);
        expect(visibleWidth(meterRow(percent, width)), `${percent}% @ ${width}`).toBe(width);
      }
    }
  });

  it('lights whole segments inside the frame for in-between progress', () => {
    // 32-cell frame → 30 inner cells. 10 % of 30 = 3 lit segments over blank interior.
    expect(lit(10, 36)).toBe(3);
    expect(frame(10, 36)).toBe(`[${'▰'.repeat(3)}${' '.repeat(27)}]`);
    // 50 % of 30 = exactly 15 lit.
    expect(lit(50, 36)).toBe(15);
  });

  it('lights every inner cell at 100 % and leaves a blank interior at 0 %', () => {
    expect(frame(100, 36)).toBe(`[${'▰'.repeat(30)}]`);
    expect(frame(0, 36)).toBe(`[${' '.repeat(30)}]`);
  });

  it('shows at least one lit segment for a tiny non-zero usage', () => {
    // 0.1 % of 30 cells rounds to 0; the meter must still show one lit segment so it is
    // distinguishable from the 0 % blank interior.
    expect(frame(0.1, 36)).toBe(`[▰${' '.repeat(29)}]`);
  });

  it('shifts the fill accent → warning → error at the 70/90 pressure thresholds', () => {
    const theme = chatTheme();
    expect(meterRow(10, 36)).toContain(theme.accent);
    expect(meterRow(10, 36)).not.toContain(theme.warning);
    expect(meterRow(70, 36)).toContain(theme.warning);
    expect(meterRow(89, 36)).toContain(theme.warning);
    expect(meterRow(90, 36)).toContain(theme.error);
    expect(meterRow(90, 36)).not.toContain(theme.warning);
  });
});
