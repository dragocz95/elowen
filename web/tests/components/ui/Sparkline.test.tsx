import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Sparkline } from '../../../components/ui/Sparkline';

/** When the shared sparkline draws at all, and when it deliberately draws nothing.
 *
 *  Only the presence rule is asserted here. jsdom computes no layout, so Recharts measures a zero-sized
 *  box and renders no geometry whatsoever — a test claiming to check the curve would pass against a
 *  blank screen. The shape itself is checked in a browser. */

const props = { colour: 'var(--color-accent)' };

describe('Sparkline', () => {
  it('draws nothing for a series that never leaves zero', () => {
    // This is the case that changed behaviour: two of the three implementations it replaced drew a flat
    // line pinned to the floor here, which reads as a recorded run of zeros rather than as no data yet.
    expect(render(<Sparkline values={[0, 0, 0, 0]} {...props} />).container).toBeEmptyDOMElement();
  });

  it('draws nothing for a series too short to have a shape', () => {
    expect(render(<Sparkline values={[5]} {...props} />).container).toBeEmptyDOMElement();
    expect(render(<Sparkline values={[]} {...props} />).container).toBeEmptyDOMElement();
  });

  it('draws once a single point rises above zero', () => {
    expect(render(<Sparkline values={[0, 1]} {...props} />).container).not.toBeEmptyDOMElement();
  });

  it('stays out of the accessibility tree in every variant', () => {
    // The figure it illustrates is always printed next to it, and Recharts would otherwise put a
    // focusable role="application" inside this aria-hidden wrapper — in one case inside a link.
    for (const variant of ['area', 'line', 'bar'] as const) {
      const { container } = render(<Sparkline values={[1, 2, 3]} variant={variant} {...props} />);
      expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
      expect(container.querySelector('[tabindex]')).toBeNull();
      expect(container.querySelector('[role="application"]')).toBeNull();
    }
  });
});
