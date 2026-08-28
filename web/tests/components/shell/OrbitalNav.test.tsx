import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
const pushSpy = vi.hoisted(() => vi.fn());
const currentPath = vi.hoisted(() => ({ value: '/dash' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: pushSpy }) }));
import { getStableOffsets, OrbitalNav, railSpacing } from '../../../components/shell/OrbitalNav';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/api/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => { localStorage.clear(); pushSpy.mockClear(); currentPath.value = '/dash'; });

function seed(client: ReturnType<typeof createWrapper>['client']) {
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
  client.setQueryData(['plugin-ui', 'en'], [
    { name: 'editor', title: 'Editor', nav: [{ label: 'Editor', icon: 'Code2', route: '' }], settings: [] },
    { name: 'subagent', title: 'Sub-agents', nav: [{ label: 'Sub-agents', icon: 'Bot', route: '' }], settings: [] },
    { name: 'cronjob', title: 'Schedules', nav: [{ label: 'Schedules', icon: 'CalendarClock', route: '' }], settings: [] },
    { name: 'skills', title: 'Skills', nav: [{ label: 'Skills', icon: 'BookOpen', route: '' }], settings: [] },
    { name: 'stats', title: 'Statistics', nav: [{ label: 'Statistics', icon: 'BarChart3', route: '' }], settings: [] },
  ]);
}

function mountNav(props: Parameters<typeof OrbitalNav>[0] = {}) {
  const { wrapper: Wrapper, client } = createWrapper();
  seed(client);
  return { view: render(<Wrapper><OrbitalNav {...props} /></Wrapper>), Wrapper };
}

function mount(compact = false) {
  return mountNav({ compact }).view;
}

describe('orbital navigation geometry', () => {
  it('parks destinations in one fixed centered order', () => {
    expect(getStableOffsets(8, 66)).toEqual([-231, -165, -99, -33, 33, 99, 165, 231]);
  });
  it('tightens spacing only when the axis needs it', () => {
    expect(railSpacing(8, 845)).toBe(48);
    // The whole point of the 48px resting spacing: a full menu on an ordinary laptop no longer has to
    // tighten at all. The rail used to render at ~72% of these numbers under an automatic page zoom, so
    // reading the old 66 as real pixels made twelve destinations overflow every 1280×800 screen.
    expect(railSpacing(12, 704)).toBe(48);
    expect(railSpacing(14, 520)).toBeLessThan(48);
  });
});

describe('OrbitalNav', () => {
  it('renders only current core and plugin destinations', () => {
    mount();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/dash');
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: 'Editor' })).toHaveAttribute('href', '/p/editor');
    expect(screen.getByRole('link', { name: 'Sub-agents' })).toHaveAttribute('href', '/p/subagent');
    expect(screen.getByRole('link', { name: 'Schedules' })).toHaveAttribute('href', '/p/cronjob');
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/p/skills');
    expect(screen.getByRole('link', { name: 'Statistics' })).toHaveAttribute('href', '/p/stats');
    expect(screen.queryByRole('link', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Sessions' })).toBeNull();
  });

  it('marks the current route and advances one route on wheel', () => {
    currentPath.value = '/projects';
    mount();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    fireEvent.wheel(screen.getByTestId('future-navigation'), { deltaY: 60 });
    expect(pushSpy).toHaveBeenCalledWith('/p/editor');
  });

  it('collapses to the icon rail without changing destinations', () => {
    mount(true);
    expect(screen.getByTestId('future-navigation')).toHaveClass('w-[3.5rem]');
    expect(screen.getByRole('link', { name: 'Statistics' })).toBeInTheDocument();
  });
});

describe('OrbitalNav as an offcanvas drawer', () => {
  const onClose = vi.fn();
  beforeEach(() => onClose.mockClear());

  /** The drawer's own tab order, read off the DOM rather than pinned to particular controls: the rail
   *  renders whatever destinations the menu holds, and the trap has to hold at whichever ends it has. */
  function tabRing() {
    const nav = screen.getByTestId('future-navigation');
    const items = Array.from(nav.querySelectorAll<HTMLElement>('a[href], button'));
    return { nav, first: items[0]!, last: items.at(-1)! };
  }

  it('keeps Tab inside the drawer, wrapping at both ends', () => {
    mountNav({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const { first, last } = tabRing();
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back in when it has escaped the drawer, which aria-modal promises', () => {
    mountNav({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(tabRing().first);
    outside.remove();
  });

  it('closes on Escape', () => {
    mountNav({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    // Counted from here: arriving somewhere already closes the drawer, so the mount itself reports one.
    const before = onClose.mock.calls.length;
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose.mock.calls.length).toBe(before + 1);
  });

  it('gives focus back to whatever opened it, but only while focus is still inside', () => {
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();

    // Opened by a re-render rather than mounted open, which is how the shell actually opens it.
    const { view, Wrapper } = mountNav({ drawer: true, drawerOpen: false, onDrawerClose: onClose });
    expect(document.activeElement).toBe(opener);

    view.rerender(<Wrapper><OrbitalNav drawer drawerOpen onDrawerClose={onClose} /></Wrapper>);
    expect(document.activeElement).toBe(tabRing().first);

    view.rerender(<Wrapper><OrbitalNav drawer drawerOpen={false} onDrawerClose={onClose} /></Wrapper>);
    expect(document.activeElement).toBe(opener);

    // Focus that has since moved elsewhere is the user's, not the drawer's to take back.
    view.rerender(<Wrapper><OrbitalNav drawer drawerOpen onDrawerClose={onClose} /></Wrapper>);
    (document.activeElement as HTMLElement).blur();
    view.rerender(<Wrapper><OrbitalNav drawer drawerOpen={false} onDrawerClose={onClose} /></Wrapper>);
    expect(document.activeElement).not.toBe(opener);

    opener.remove();
  });
});
