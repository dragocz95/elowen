import { describe, expect, it, vi } from 'vitest';
import { cloneElement, type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MeterBar } from '../../../components/ui/MeterBar';
import { createWrapper } from '../../test-utils';

/** WHAT THE METER DRAWS, which is a different question from what it announces (`MeterBar.test.tsx`).
 *
 *  jsdom performs no layout, so `ResponsiveContainer` would measure a zero-sized box and Recharts would
 *  render no geometry at all — an assertion about the bar would then pass against a blank screen. Giving
 *  the chart a fixed size is what makes the drawing real here, and ONLY the measurement is replaced:
 *  everything below it is Recharts' own code, including the `minPointSize` rule and the rectangle
 *  filtering under test. How a filled bar divides a real track is still measured in a browser
 *  (`projects.cards.e2e.ts`). */
vi.mock('recharts', async (loadOriginal) => {
  const actual = await loadOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement<{ width: number; height: number }> }) =>
      cloneElement(children, { width: 200, height: 8 }),
  };
});

const draw = (percent: number) => render(
  <MeterBar percent={percent} colour="var(--color-primary)" label="CPU" valueText={`CPU: ${percent}%`} />,
  { wrapper: createWrapper().wrapper },
);

const trackDrawn = (): boolean => document.querySelector('.recharts-bar-background-rectangle') !== null;
/** Recharts drops a rectangle with nothing in it rather than emitting one, so presence IS the reading. */
const fillDrawn = (): boolean => document.querySelector('.recharts-bar-rectangle path') !== null;

/** The outline of the fill, which is the reading in pixels: Recharts draws the shape it is handed, so the
 *  path's `d` is the only thing that tells a sliver widened to the floor from one drawn at its own width.
 *  Presence alone cannot: any width above zero reaches the shape. */
const fillOutline = (percent: number): string | null => {
  const { unmount } = draw(percent);
  const outline = document.querySelector('.recharts-bar-rectangle path')?.getAttribute('d') ?? null;
  unmount();
  return outline;
};

describe('MeterBar geometry', () => {
  it('draws the track and a fill for a reading with something in it', () => {
    draw(42);
    expect(trackDrawn()).toBe(true);
    expect(fillDrawn()).toBe(true);
  });

  /** The case a poll of an idle environment produces. `minPointSize` widens every rectangle narrower than
   *  itself, an exact zero included, so this used to paint a sliver of a share that was not being used —
   *  and a meter may never claim that. The track is the ceiling and belongs on screen in every state: a
   *  zero reading shows an untouched channel, not a meter that has gone missing. */
  it('draws the track but no fill at all for an exact zero', () => {
    draw(0);
    expect(document.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '0');
    expect(trackDrawn(), 'the zero reading lost its track').toBe(true);
    expect(fillDrawn(), 'a zero reading was drawn as a sliver of the track').toBe(false);
  });

  /** The other half of the same rule: a real but tiny fraction still shows something, so a meter that is
   *  barely used never reads as untouched. `minPointSize` is what makes that true — Recharts applies the
   *  floor BEFORE it calls the shape, so 0.05 % is drawn as wide as the floor rather than as the 0.1 px
   *  its share of a 200 px track comes to. Comparing it against a reading that fills the floor exactly
   *  (1 % of this track IS the 2 px floor) is what pins the floor down: the shape's own `width > 0` draws
   *  the tiny reading too, at a tenth of the width. */
  it('widens a fraction too small to be a whole pixel to the same floor as one that fills it exactly', () => {
    const tiny = fillOutline(0.05);
    expect(tiny, 'a real but tiny reading vanished').not.toBeNull();
    expect(fillOutline(1), 'a 1 % reading is exactly the 2 px floor').toBe(tiny);
  });
});
