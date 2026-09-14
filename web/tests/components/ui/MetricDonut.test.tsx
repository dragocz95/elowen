import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetricDonut } from '../../../components/ui/MetricDonut';
import { createWrapper } from '../../test-utils';

/** WHAT THE RING ANNOUNCES AND WHAT IT DRAWS.
 *
 *  Both are answerable here, unlike the bar it replaced: this chart is sized in pixels
 *  rather than by `ResponsiveContainer`, precisely so that its first paint is identical to its hundredth
 *  and does not wait on a measured box. That makes the geometry real under jsdom too, so the sector count
 *  and the arc's own path are assertions rather than guesses. How the arc divides a real circle on screen
 *  is still measured in a browser (`projects.cards.e2e.ts`). */
const draw = (props: Partial<Parameters<typeof MetricDonut>[0]> = {}) => render(
  <MetricDonut percent={42} colour="var(--color-primary)" label="CPU" valueText="CPU: 42%" centre="42%" {...props} />,
  { wrapper: createWrapper().wrapper },
);

const arc = () => document.querySelector('.metric-donut-arc');
const track = () => document.querySelector('.metric-donut-track');

describe('MetricDonut', () => {
  it('is the reading, not a picture of one', () => {
    draw();
    const meter = screen.getByRole('progressbar', { name: 'CPU' });
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    // The spoken text is the sentence the sighted reader gets, not "42 percent" of an unnamed thing.
    expect(meter).toHaveAttribute('aria-valuetext', 'CPU: 42%');
  });

  /** A screen reader that walked into the chart would describe sectors instead of reading the figure, and
   *  Recharts' own keyboard layer would add a focus stop inside a card that already owns one. The value in
   *  the hole is hidden for the same reason: the wrapper has already said it. */
  it('hides the drawing and the centred figure from assistive technology', () => {
    const { container } = draw();
    const meter = screen.getByRole('progressbar', { name: 'CPU' });
    // Two: the chart itself, and the figure in the hole that repeats what the wrapper already announces.
    expect(meter.querySelectorAll('[aria-hidden="true"]').length).toBe(2);
    expect(container.querySelector('[role="application"]')).toBeNull();
    // Recharts still emits an internal `tabindex="-1"` layer, which is not reachable by tab. What must
    // not exist is a REAL stop inside a card whose only tab stop is its own open button.
    const focusable = [...container.querySelectorAll('[tabindex]')]
      .filter((node) => Number(node.getAttribute('tabindex')) >= 0)
      .map((node) => node.tagName);
    expect(focusable, 'the chart added a tab stop inside the card').toEqual([]);
  });

  it('keeps the measured fraction in its numeric accessibility value', () => {
    draw({ percent: 41.6, valueText: 'RAM: 416 MiB / 1 GiB' });
    expect(screen.getByRole('progressbar', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '41.6');
  });

  it('draws an arc and its remaining track for a reading with something in it', () => {
    draw();
    expect(arc()).not.toBeNull();
    expect(track()).not.toBeNull();
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  /** The case a poll of an idle environment produces. The meaning of a meter is the part that is NOT
   *  filled, and at zero that part is all of it — so the ring is complete and there is no arc at all. A
   *  visible-floor rule that lifted every small reading, an exact zero included, is what used to put a
   *  sliver of CPU nobody was using on the bar this replaced. */
  it('draws a complete track and no arc whatsoever at an exact zero', () => {
    draw({ percent: 0, centre: '0%' });
    expect(screen.getByRole('progressbar', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '0');
    expect(track(), 'the zero reading lost its track').not.toBeNull();
    expect(arc(), 'a zero reading was drawn as a sliver of the ring').toBeNull();
  });

  /** The other half of the same rule: a real but tiny fraction still shows an arc, so a resource that is
   *  barely used never reads as untouched. It is lifted to the same visible floor a reading that fills
   *  the floor exactly is drawn at, which is what pins the floor down — presence alone cannot, since any
   *  sweep above zero produces a path. */
  it('lifts a fraction too small to see to the same floor as one that fills it exactly', () => {
    const outline = (percent: number) => {
      const { unmount } = draw({ percent });
      const path = document.querySelector('.metric-donut-arc')?.getAttribute('d') ?? null;
      unmount();
      return path;
    };
    const tiny = outline(0.05);
    expect(tiny, 'a real but tiny reading vanished').not.toBeNull();
    expect(outline(2), 'a 2 % reading is exactly the visible floor').toBe(tiny);
  });

  /** At the ceiling the remainder is nothing, and a zero-width track sector stacked on a complete arc is
   *  the hairline artifact this filtering exists to prevent. */
  it('draws one complete arc and no leftover track at the ceiling', () => {
    draw({ percent: 100, centre: '100%' });
    expect(arc()).not.toBeNull();
    expect(track(), 'a full ring kept an empty remainder on top of itself').toBeNull();
  });

  /** Nothing measured is NOT nothing used. The ring keeps its shape so the strip does not move when the
   *  sample lands, and it is an image with the honest sentence for a name rather than a progressbar
   *  reporting a value it does not have. */
  it('draws the track alone and claims no value when nothing has been measured', () => {
    draw({ percent: null, valueText: 'CPU: —', centre: '—' });
    expect(screen.queryByRole('progressbar')).toBeNull();
    const unknown = screen.getByRole('img', { name: 'CPU: —' });
    expect(unknown).toHaveAttribute('data-metric-donut', 'unknown');
    expect(track()).not.toBeNull();
    expect(arc(), 'an unmeasured resource was drawn as if it had a reading').toBeNull();
  });

  /** A reading nobody can make sense of is not drawn as one. The register's own caller already refuses a
   *  non-finite figure, and the ring refuses it too rather than emitting `NaN` into a path. */
  it('treats an unusable figure as unmeasured instead of drawing it', () => {
    draw({ percent: Number.NaN, valueText: 'CPU: —', centre: '—' });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(arc()).toBeNull();
    expect(track()).not.toBeNull();
  });

  /** An out-of-range figure is clamped rather than wrapped around the circle. */
  it('clamps a reading above the ceiling to one complete ring', () => {
    draw({ percent: 140, centre: '100%' });
    expect(screen.getByRole('progressbar', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '100');
    expect(arc()).not.toBeNull();
    expect(track()).toBeNull();
  });

  /** Recharts animates a pie by default. On a register these are re-read on a poll, so an animated ring
   *  replays a sweep-from-zero every thirty seconds — and, worse, the first frame a reader sees is not
   *  the figure printed beside it. */
  it('never animates, so the first paint is already the final geometry', () => {
    const { container } = draw();
    expect(container.querySelector('.recharts-pie')).not.toBeNull();
    expect(container.querySelector('animate, animateTransform')).toBeNull();
  });
});
