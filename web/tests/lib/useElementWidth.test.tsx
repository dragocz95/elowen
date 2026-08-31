import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RefCallback } from 'react';
import { useElementWidth } from '../../lib/useElementWidth';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(node: Element) { this.observed.push(node); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
  emit(width: number) {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function Probe({ branch, refs }: { branch: 'div' | 'section'; refs: RefCallback<HTMLElement>[] }) {
  const [ref, width, measured] = useElementWidth<HTMLElement>();
  refs.push(ref);
  return branch === 'div'
    ? <div key="div" ref={ref} data-testid="measured" data-width={width} data-measured={measured} />
    : <section key="section" ref={ref} data-testid="measured" data-width={width} data-measured={measured} />;
}

describe('useElementWidth', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.instances.length = 0;
  });

  it('reattaches a stable callback ref when React replaces the measured DOM node', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const refs: RefCallback<HTMLElement>[] = [];
    const view = render(<Probe branch="div" refs={refs} />);
    const firstNode = view.getByTestId('measured');
    const firstObserver = FakeResizeObserver.instances[0]!;
    expect(firstObserver.observed).toEqual([firstNode]);
    expect(firstNode).toHaveAttribute('data-measured', 'false');

    act(() => firstObserver.emit(390));
    expect(firstNode).toHaveAttribute('data-width', '390');
    expect(firstNode).toHaveAttribute('data-measured', 'true');

    view.rerender(<Probe branch="section" refs={refs} />);
    const secondNode = view.getByTestId('measured');
    const secondObserver = FakeResizeObserver.instances[1]!;
    expect(secondNode).not.toBe(firstNode);
    expect(refs.at(-1)).toBe(refs[0]);
    expect(firstObserver.disconnected).toBe(true);
    expect(secondObserver.observed).toEqual([secondNode]);
    expect(secondNode).toHaveAttribute('data-width', '0');
    expect(secondNode).toHaveAttribute('data-measured', 'false');

    act(() => secondObserver.emit(390));
    expect(secondNode).toHaveAttribute('data-width', '390');
    expect(secondNode).toHaveAttribute('data-measured', 'true');
  });
});
