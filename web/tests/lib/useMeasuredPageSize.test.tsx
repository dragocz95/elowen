import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import { useMeasuredPageSize } from '../../lib/useMeasuredPageSize';

/** jsdom lays nothing out, so the sizes the hook reads off the DOM are declared per element instead:
 *  `data-h` is the height of that node, and the scroll box reports it as its own client height. */
const originalRect = Element.prototype.getBoundingClientRect;
const declaredHeight = (el: Element): number => Number((el as HTMLElement).dataset.h ?? 0);

/** The scroll box the hook measures, with a header row and however many conversation rows the table has
 *  rendered so far — none at all while the listing is still loading, which is the case that matters. */
function Probe({ rows, box = 440 }: { rows: number; box?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pageSize } = useMeasuredPageSize(ref);
  return (
    <div>
      <div ref={ref} data-h={String(box)}>
        {rows > 0 && <div role="row" data-h="40" />}
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} role="row" data-tree-row="root" data-h="80" />
        ))}
      </div>
      <span data-testid="size">{pageSize}</span>
    </div>
  );
}

describe('useMeasuredPageSize', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return declaredHeight(this); },
    });
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { height: declaredHeight(this), width: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    };
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Element.prototype.getBoundingClientRect = originalRect;
  });

  it('re-measures once the rows arrive, instead of keeping the guess made against an empty table', () => {
    // The listing renders nothing while it loads, so the first measurement can only use the fallback row
    // height: 440 of box over 44 gives ten. The box itself never resizes when the table replaces that
    // empty state, so a measurement bound to the resize observer alone would stop here and be wrong.
    const view = render(<Probe rows={0} />);
    expect(screen.getByTestId('size')).toHaveTextContent('10');

    // With real rows the answer is the honest one: the header eats 40 of the 440, and a root row is 80.
    view.rerender(<Probe rows={4} />);
    expect(screen.getByTestId('size')).toHaveTextContent('5');
  });

  it('keeps the last good answer when the surface cannot be measured at all', () => {
    // A hidden or detached box reports no height. Guessing from a zero would page the table down to its
    // minimum and then jump back the moment the surface is shown again.
    const view = render(<Probe rows={4} />);
    expect(screen.getByTestId('size')).toHaveTextContent('5');
    view.rerender(<Probe rows={4} box={0} />);
    expect(screen.getByTestId('size')).toHaveTextContent('5');
  });
});
