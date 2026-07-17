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

/** The Context meter row is the only one carrying the dashed track (the flame logo uses ▀▄). */
const meterRow = (percent: number, width = 36): string =>
  new TelemetryPanel(() => stateAt(percent)).render(width).find((line) => strip(line).includes('╌') || /█/.test(strip(line)))!;

describe('the usage meter', () => {
  it('spans the panel minus equal margins at any width, fractions included', () => {
    for (const width of [36, 40, 46, 60]) {
      for (const percent of [0, 10, 33, 50, 75, 100]) {
        const row = meterRow(percent, width);
        const cells = strip(row).match(/[█▏▎▍▌▋▊▉╌]/g)!.length;
        expect(cells, `${percent}% @ ${width}`).toBe(width - 4);
        expect(visibleWidth(row)).toBe(width);
      }
    }
  });

  it('renders a fractional head cell for in-between progress', () => {
    // 10 % of 32 cells = 3.2 → three full blocks, one quarter-ish head, dashed track.
    expect(strip(meterRow(10, 36))).toContain('███▎');
    // 50 % of 32 cells = exactly 16 → no fractional head.
    expect(strip(meterRow(50, 36))).toContain('█'.repeat(16) + '╌');
    expect(strip(meterRow(50, 36))).not.toMatch(/[▏▎▍▌▋▊▉]/);
  });

  it('fills fully at 100 % and stays an empty track at 0 %', () => {
    expect(strip(meterRow(100, 36))).toContain('█'.repeat(32));
    expect(strip(meterRow(0, 36))).toContain('╌'.repeat(32));
    expect(strip(meterRow(0, 36))).not.toContain('█');
  });

  it('shows at least one eighth for a tiny non-zero usage', () => {
    // 0.1 % of 32 cells rounds to 0 eighths; the meter must still show a fractional head so it is
    // distinguishable from the 0 % empty track.
    const tiny = strip(meterRow(0.1, 36));
    expect(tiny).toMatch(/[▏▎▍▌▋▊▉]/);
    expect(tiny).not.toBe('╌'.repeat(32));
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
