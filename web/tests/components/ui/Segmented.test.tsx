import { useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Segmented } from '../../../components/ui/Segmented';

const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Segmented', () => {
  it('renders a segment per option and marks the active one', () => {
    render(<Segmented options={opts} value="b" onChange={() => {}} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(screen.getByRole('radio', { name: 'B' }).getAttribute('aria-checked')).toBe('true');
  });

  it('fires onChange with the clicked value', () => {
    const onChange = vi.fn();
    render(<Segmented options={opts} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'C' }));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('uses Radix roving focus and arrow keys for the radio group', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState('b');
      return (
        <Segmented
          aria-label="Mode"
          options={opts}
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      );
    }
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Mode' });
    const active = screen.getByRole('radio', { name: 'B' });
    const next = screen.getByRole('radio', { name: 'C' });
    expect(group).toHaveAttribute('tabindex', '0');
    act(() => group.focus());
    await waitFor(() => expect(active).toHaveFocus());
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    await waitFor(() => expect(next).toHaveFocus());
    expect(next).toHaveAttribute('aria-checked', 'true');
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('offers a quiet underline variant for settings navigation', () => {
    render(<Segmented variant="line" options={opts} value="b" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toHaveClass('border-b');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('data-state', 'unchecked');
  });

  it('reveals the active option on the horizontal axis without moving the page vertically', async () => {
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const { rerender } = render(<Segmented nowrap options={opts} value="a" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup');
    const target = screen.getByRole('radio', { name: 'C' });
    Object.defineProperties(group, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    vi.spyOn(group, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 100, top: 300, bottom: 340, width: 100, height: 40, x: 0, y: 300, toJSON: () => ({}) });
    vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => ({ left: 150 - group.scrollLeft, right: 210 - group.scrollLeft, top: 900, bottom: 940, width: 60, height: 40, x: 150 - group.scrollLeft, y: 900, toJSON: () => ({}) }));
    document.documentElement.scrollTop = 75;

    await act(async () => {
      rerender(<Segmented nowrap options={opts} value="c" onChange={() => {}} />);
      await Promise.resolve();
    });

    expect(group.scrollLeft).toBe(110);
    expect(document.documentElement.scrollTop).toBe(75);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('measures real overflow and exposes the hidden edges', () => {
    let resize: (() => void) | undefined;
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });

    render(<Segmented nowrap options={opts} value="b" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup');
    Object.defineProperties(group, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 260 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });

    act(() => resize?.());
    expect(group).toHaveAttribute('data-nowrap', 'true');
    expect(group).toHaveAttribute('data-overflow', 'true');
    expect(group).toHaveAttribute('data-overflow-left', 'false');
    expect(group).toHaveAttribute('data-overflow-right', 'true');
    expect(group.style.getPropertyValue('--segmented-edge-fade-left')).toBe('0px');
    expect(group.style.getPropertyValue('--segmented-edge-fade-right')).toBe('var(--segmented-edge-fade-size)');

    group.scrollLeft = 160;
    fireEvent.scroll(group);
    expect(group).toHaveAttribute('data-overflow-left', 'true');
    expect(group).toHaveAttribute('data-overflow-right', 'false');
  });

  it('remeasures overflow when translated label text changes without changing option count', async () => {
    let scrollWidth = 100;
    render(<Segmented nowrap options={opts} value="a" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup');
    Object.defineProperties(group, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, get: () => scrollWidth },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    fireEvent.scroll(group);
    expect(group).toHaveAttribute('data-overflow', 'false');

    scrollWidth = 240;
    act(() => { screen.getByText('A').firstChild!.nodeValue = 'A much longer translated label'; });

    await waitFor(() => expect(group).toHaveAttribute('data-overflow', 'true'));
    expect(group).toHaveAttribute('data-overflow-right', 'true');
  });

  it('normalizes Firefox line/page wheel modes and ignores ctrl-wheel pinch gestures', () => {
    render(<Segmented nowrap options={opts} value="b" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup');
    group.style.lineHeight = '20px';
    Object.defineProperties(group, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
      scrollWidth: { configurable: true, value: 500 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });

    const pixel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 10, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
    fireEvent(group, pixel);
    expect(pixel.defaultPrevented).toBe(true);
    expect(group.scrollLeft).toBe(10);

    const line = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE });
    fireEvent(group, line);
    expect(line.defaultPrevented).toBe(true);
    expect(group.scrollLeft).toBe(50);

    const page = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE });
    fireEvent(group, page);
    expect(page.defaultPrevented).toBe(true);
    expect(group.scrollLeft).toBe(90);

    const pinch = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 80 });
    fireEvent(group, pinch);
    expect(pinch.defaultPrevented).toBe(false);
    expect(group.scrollLeft).toBe(90);
  });

  it('maps dominant vertical wheel input only while that direction can actually move', () => {
    render(<Segmented nowrap options={opts} value="b" onChange={() => {}} />);
    const group = screen.getByRole('radiogroup');
    Object.defineProperties(group, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 40 },
      scrollWidth: { configurable: true, value: 260 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
    });
    const dispatch = (event: WheelEvent) => act(() => { fireEvent(group, event); });

    const backwardAtStart = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -40 });
    dispatch(backwardAtStart);
    expect(backwardAtStart.defaultPrevented).toBe(false);
    expect(group.scrollLeft).toBe(0);

    const forward = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 });
    dispatch(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(group.scrollLeft).toBe(40);

    group.scrollLeft = 160;
    const forwardAtEnd = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 });
    dispatch(forwardAtEnd);
    expect(forwardAtEnd.defaultPrevented).toBe(false);
    expect(group.scrollLeft).toBe(160);

    const horizontal = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 50, deltaY: 20 });
    dispatch(horizontal);
    expect(horizontal.defaultPrevented).toBe(false);
  });

  it('offers a vertical menu variant for secondary controls', () => {
    render(<Segmented variant="menu" options={opts} value="b" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getByRole('radiogroup')).toHaveClass('flex-col', 'items-stretch');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveClass('w-full');
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('data-state', 'checked');
  });
});
