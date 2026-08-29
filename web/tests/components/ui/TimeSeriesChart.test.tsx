import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeSeriesChart } from '../../../components/ui/TimeSeriesChart';

/** What the wrapper decides before Recharts is ever fetched.
 *
 *  The drawing itself is not asserted: jsdom computes no layout, so Recharts measures a zero-sized box
 *  and renders no geometry — a test claiming to check the bars would pass against a blank screen. The
 *  picture is verified in a browser; what is worth pinning here is the branch that keeps a 376 KB
 *  library out of the page, and the formatting contract the caller owns. */

const series = [
  { key: 'tokens', label: 'Tokens', colour: 'var(--color-primary)', variant: 'bar' as const, axis: 'left' as const, format: (v: number) => `${v}t` },
  { key: 'cost', label: 'Cost', colour: 'var(--color-warning)', variant: 'line' as const, axis: 'right' as const, format: (v: number) => `$${v}` },
];

describe('TimeSeriesChart', () => {
  it('answers an empty range without reaching for the charting library', () => {
    const format = vi.fn((v: number) => String(v));
    const { container } = render(
      <TimeSeriesChart data={[]} series={[{ ...series[0]!, format }]} emptyText="No data yet" />,
    );

    expect(screen.getByText('No data yet')).toBeInTheDocument();
    // No Suspense boundary means no dynamic import was started: an empty range should not download a
    // charting library only to say it has nothing to draw.
    expect(container.querySelector('[aria-hidden]')).toBeNull();
    expect(format).not.toHaveBeenCalled();
  });
});
