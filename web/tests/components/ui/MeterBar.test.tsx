import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeterBar } from '../../../components/ui/MeterBar';
import { createWrapper } from '../../test-utils';

/** The meter is a chart, and a chart has no measured size under jsdom — so what is asserted here is the
 *  part that exists without layout: the reading a screen reader is given. That the filled bar is actually
 *  a fraction of a fixed 0..100 domain is geometry, and it is proven in the browser instead. */
describe('MeterBar', () => {
  const draw = (props: Partial<Parameters<typeof MeterBar>[0]> = {}) => render(
    <MeterBar percent={42} colour="var(--color-primary)" label="CPU" valueText="CPU: 42%" {...props} />,
    { wrapper: createWrapper().wrapper },
  );

  it('is the reading, not a picture of one', () => {
    draw();
    const meter = screen.getByRole('progressbar', { name: 'CPU' });
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    // The spoken text is the sentence the sighted reader gets, not "42 percent" of an unnamed thing.
    expect(meter).toHaveAttribute('aria-valuetext', 'CPU: 42%');
  });

  /** A screen reader that walked into the chart would describe a rectangle instead of reading the figure,
   *  and recharts' own keyboard layer would add a focus stop inside a card that is already a link. */
  it('hides the drawing from assistive technology', () => {
    const { container } = draw();
    const meter = screen.getByRole('progressbar', { name: 'CPU' });
    expect(meter.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[role="application"]')).toBeNull();
    expect(container.querySelector('[tabindex]')).toBeNull();
  });

  it('reports a fractional reading as the whole number a reader hears', () => {
    draw({ percent: 41.6, valueText: 'RAM: 416 MiB / 1 GiB' });
    expect(screen.getByRole('progressbar', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '42');
  });

  it('lets the caller own its height, because these sit in cards and drawers of different sizes', () => {
    draw({ className: 'h-2' });
    expect(screen.getByRole('progressbar', { name: 'CPU' })).toHaveClass('h-2');
  });
});
