import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDockState } from '../../lib/useDockState';

describe('useDockState', () => {
  it('defaults to a closed right-docked advisor panel', () => {
    const { result } = renderHook(() => useDockState());
    expect(result.current.state).toEqual({ open: false, side: 'right', width: 560, height: 420 });
  });

  it('updates visibility and dimensions', () => {
    const { result } = renderHook(() => useDockState());
    act(() => result.current.setOpen(true));
    act(() => result.current.setWidth(700));
    act(() => result.current.setHeight(500));
    expect(result.current.state).toMatchObject({ open: true, width: 700, height: 500 });
  });

  it('persists the dock side across mounts', () => {
    const first = renderHook(() => useDockState());
    act(() => first.result.current.setSide('left'));
    first.unmount();
    const second = renderHook(() => useDockState());
    expect(second.result.current.state.side).toBe('left');
  });
});
