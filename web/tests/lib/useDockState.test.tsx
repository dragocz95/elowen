import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDockState } from '../../lib/useDockState';

describe('useDockState', () => {
  it('defaults to a closed right-docked panel with just the advisor pane', () => {
    const { result } = renderHook(() => useDockState());
    expect(result.current.state.open).toBe(false);
    expect(result.current.state.side).toBe('right');
    expect(result.current.state.panes).toEqual([{ id: 'advisor', kind: 'advisor' }]);
    expect(result.current.state.sizes).toEqual([1]);
  });

  it('adds a session pane (idempotent by name) and keeps sizes aligned', () => {
    const { result } = renderHook(() => useDockState());
    act(() => result.current.addSessionPane('orca-x'));
    expect(result.current.state.panes).toHaveLength(2);
    expect(result.current.state.sizes).toHaveLength(2);
    act(() => result.current.addSessionPane('orca-x')); // duplicate → no-op
    expect(result.current.state.panes).toHaveLength(2);
  });

  it('never removes the advisor pane but does remove session panes', () => {
    const { result } = renderHook(() => useDockState());
    act(() => result.current.addSessionPane('orca-x'));
    act(() => result.current.removePane('advisor'));
    expect(result.current.state.panes.some((p) => p.kind === 'advisor')).toBe(true);
    act(() => result.current.removePane('orca-x'));
    expect(result.current.state.panes).toHaveLength(1);
    expect(result.current.state.sizes).toHaveLength(1);
  });

  it('persists the dock side across mounts', () => {
    const first = renderHook(() => useDockState());
    act(() => first.result.current.setSide('left'));
    first.unmount();
    const second = renderHook(() => useDockState());
    expect(second.result.current.state.side).toBe('left');
  });
});
