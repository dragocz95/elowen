import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useOpenSubMenus } from '../../../components/shell/useOpenSubMenus';

const key = (userId: number) => `elowen.nav.submenus.${userId}`;

describe('useOpenSubMenus', () => {
  beforeEach(() => { localStorage.clear(); });

  it('remembers a fold per account', () => {
    const { result } = renderHook(() => useOpenSubMenus(1));
    act(() => result.current.toggle('work'));
    expect(result.current.isOpen('work')).toBe(true);
    expect(JSON.parse(localStorage.getItem(key(1))!)).toEqual(['work']);

    // Another account on the same machine inherits nothing.
    const other = renderHook(() => useOpenSubMenus(2));
    expect(other.result.current.isOpen('work')).toBe(false);
  });

  it('opens the section holding the page the reader arrived at', () => {
    const { result } = renderHook(() => useOpenSubMenus(1, 'settings'));
    expect(result.current.isOpen('settings')).toBe(true);
  });

  it('keeps the route fold when the account arrives after it', () => {
    // The account is answered by a request and the route is not, so this is the ORDER of a normal page
    // load: the column mounts knowing where the reader is and learns who they are a moment later. An
    // identity effect that assigned the stored list would close the section they are standing in.
    localStorage.setItem(key(1), JSON.stringify(['work']));
    const { result, rerender } = renderHook(
      ({ userId }: { userId: number | null }) => useOpenSubMenus(userId, 'settings'),
      { initialProps: { userId: null as number | null } },
    );
    expect(result.current.isOpen('settings')).toBe(true);

    rerender({ userId: 1 });
    expect(result.current.isOpen('settings')).toBe(true);
    expect(result.current.isOpen('work')).toBe(true);
  });

  it('lets the reader close the section they arrived in', () => {
    const { result } = renderHook(() => useOpenSubMenus(1, 'settings'));
    act(() => result.current.toggle('settings'));
    expect(result.current.isOpen('settings')).toBe(false);
  });

  it('ignores a stored value that is not a list of ids', () => {
    localStorage.setItem(key(1), '{"work":true}');
    const { result } = renderHook(() => useOpenSubMenus(1));
    expect(result.current.isOpen('work')).toBe(false);
  });
});
