import { beforeEach, describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDockState, type DockProfile } from '../../lib/useDockState';

describe('useDockState', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to a closed right-docked advisor panel', () => {
    const { result } = renderHook(() => useDockState());
    expect(result.current.state).toEqual({ open: false, side: 'right', width: 560, height: 420 });
  });

  it('keeps Studio closed until the user opens it and persists that choice', () => {
    const first = renderHook(() => useDockState('command'));
    expect(first.result.current.state).toEqual({ open: false, side: 'right', width: 336, height: 420 });

    act(() => first.result.current.setOpen(true));
    first.unmount();

    const second = renderHook(() => useDockState('command'));
    expect(second.result.current.state.open).toBe(true);
  });

  it('does not carry an open dock into Studio while its own state loads', () => {
    const hook = renderHook(({ profile }: { profile: DockProfile }) => useDockState(profile), {
      initialProps: { profile: 'spatial' },
    });
    act(() => hook.result.current.setOpen(true));
    hook.rerender({ profile: 'command' });
    expect(hook.result.current.state.open).toBe(false);
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
