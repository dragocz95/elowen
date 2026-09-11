import { describe, it, expect } from 'vitest';
import { activityChip, statusline } from '../../../src/cli/chat/composeLines.js';
import { terminalPlainText } from '../../../src/cli/ui/text.js';

/** Output speed in the statusline and the composer chip.
 *
 *  The interesting cases are all about ABSENCE. `effectiveTps` is the effective rate of the LATEST
 *  completed measured model call — whole logical request from initiation, header waits, prompt
 *  processing, reasoning and retries included — so a fresh conversation legitimately has no figure at
 *  all, and rendering that as "0 tok/s" would claim the model has stalled rather than that nothing has
 *  been measured yet. */

const usage = (over: Partial<Parameters<typeof statusline>[1] & object> = {}) => ({
  tokens: 1000, contextWindow: 200_000, percent: 5, totalTokens: 5000, cost: 1.25, ...over,
});
const plain = (s: string | undefined): string => terminalPlainText(s ?? '');

describe('statusline — output speed', () => {
  it('reports the effective speed of the latest completed call when the toggle is on', () => {
    const line = plain(statusline({ showSpeed: true }, usage({ effectiveTps: 70.3 }), 'opus'));
    expect(line).toContain('70 tok/s');
  });

  it('stays silent when nothing has been measured yet', () => {
    // null means "no measured generation", which is not the same claim as "zero tokens per second".
    expect(plain(statusline({ showSpeed: true }, usage({ effectiveTps: null }), 'opus'))).not.toContain('tok/s');
    expect(plain(statusline({ showSpeed: true }, usage(), 'opus'))).not.toContain('tok/s');
    // A legacy-only session (pre-effective history) reports nothing rather than the blended old figure.
    expect(plain(statusline({ showSpeed: true }, usage({ outputTps: 70 }), 'opus'))).not.toContain('tok/s');
  });

  it('withholds a sub-1 rate rather than rounding it to a stall', () => {
    // 0.4 t/s rounds to "0 tok/s", which reads as a hang instead of as too few samples.
    expect(plain(statusline({ showSpeed: true }, usage({ effectiveTps: 0.4 }), 'opus'))).not.toContain('0 tok/s');
  });

  it('shows nothing at all while the toggle is off', () => {
    expect(plain(statusline({ showTokens: true }, usage({ effectiveTps: 70 }), 'opus'))).not.toContain('tok/s');
  });
});

describe('activityChip — output speed', () => {
  it('puts the rate beside the elapsed time', () => {
    const chip = plain(activityChip('agent', 46, 70.3));
    expect(chip).toContain('46s');
    expect(chip).toContain('70 t/s');
  });

  it('keeps the elapsed time when the rate is unknown', () => {
    // The duration is the load-bearing part of the chip; speed is an extra that may simply be absent.
    const chip = plain(activityChip('agent', 46, null));
    expect(chip).toContain('46s');
    expect(chip).not.toContain('t/s');
  });

  it('draws no chip at all when nothing is running', () => {
    expect(activityChip(null, 46, 70)).toBeUndefined();
  });
});
