import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
const currentPath = vi.hoisted(() => ({ value: '/dash' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: vi.fn() }) }));
import { StudioNavigation } from '../../../components/shell/StudioNavigation';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.26.0' })));
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => { localStorage.clear(); currentPath.value = '/dash'; });

/** A plugin contributing TWO pages is the only thing in the model that produces a group: one page is a
 *  plain destination, and a world naming a single child (projects) is not a disclosure worth drawing. */
function mount(props: Parameters<typeof StudioNavigation>[0] = {}) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
  client.setQueryData(['plugin-ui', 'en'], [
    { name: 'skills', title: 'Skills', nav: [{ label: 'Skills', icon: 'BookOpen', route: '' }], settings: [] },
    {
      name: 'work',
      title: 'Work',
      label: 'Work',
      nav: [
        { label: 'Board', icon: 'LayoutGrid', route: 'board' },
        { label: 'Timeline', icon: 'CalendarClock', route: 'timeline' },
      ],
      settings: [],
    },
  ]);
  return render(<Wrapper><StudioNavigation {...props} /></Wrapper>);
}

describe('StudioNavigation destinations', () => {
  it('renders the same navigation model the rail does, with core and plugin destinations', () => {
    mount();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/dash');
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/p/skills');
    expect(screen.getByRole('link', { name: 'Memory' })).toHaveAttribute('href', '/memory');
  });

  it('puts the account and administration entries in the footer, not among the destinations', () => {
    const { container } = mount();
    const footer = container.querySelector('.studio-nav__footer');
    expect(footer).not.toBeNull();
    for (const name of ['Account', 'Settings', 'Users']) {
      const link = screen.getByRole('link', { name });
      expect(footer!.contains(link), `${name} is not in the footer`).toBe(true);
    }
    expect(container.querySelector('.studio-nav__body')!.contains(screen.getByRole('link', { name: 'Account' }))).toBe(false);
  });

  it('marks the current route with aria-current, through the world it belongs to', () => {
    currentPath.value = '/projects';
    mount();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('names a destination only where its label is off screen: aria-label folded, title expanded', () => {
    const expanded = mount();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('title', 'Home');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-label');
    expanded.unmount();

    mount({ compact: true });
    // The icon column drops the label text, so the accessible name has to come from the attribute.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-label', 'Home');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('title');
  });
});

describe('StudioNavigation grouping', () => {
  it('groups a multi-page world under one disclosure, and leaves a single-page world a plain link', () => {
    mount();
    const group = screen.getByRole('button', { name: 'Work' });
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/p/work/board');
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/p/work/timeline');
    // A world naming one page of its own is a destination, not a group with a single child in it.
    expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  });

  it('folds a group shut, hiding its pages', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Timeline' })).toBeNull();
  });

  it('keeps the page you are standing on visible when its group is folded shut', () => {
    // The one case a disclosure must not get wrong: closing the group the reader is INSIDE would take the
    // current destination out of the menu they navigate with, leaving nothing marked as where they are.
    currentPath.value = '/p/work/timeline';
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
  });

  it('never folds a group in the icon column, where every page stays one click away', () => {
    currentPath.value = '/p/work/timeline';
    mount({ compact: true });
    expect(screen.queryByRole('button', { name: 'Work' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('StudioNavigation as an offcanvas sheet', () => {
  const onClose = vi.fn();
  beforeEach(() => onClose.mockClear());

  it('is inert and unannounced while closed, and claims a modal dialog only once open', () => {
    const closed = mount({ drawer: true, drawerOpen: false, onDrawerClose: onClose });
    const nav = screen.getByTestId('studio-navigation');
    expect(nav).toHaveAttribute('role', 'dialog');
    expect(nav).not.toHaveAttribute('aria-modal');
    expect(nav).toHaveAttribute('aria-hidden', 'true');
    expect(nav).toHaveAttribute('inert');
    closed.unmount();

    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const open = screen.getByTestId('studio-navigation');
    expect(open).toHaveAttribute('aria-modal', 'true');
    expect(open).not.toHaveAttribute('aria-hidden');
    expect(open).not.toHaveAttribute('inert');
  });

  it('claims no dialog role at all as a column, where it is chrome rather than a layer', () => {
    mount();
    const nav = screen.getByTestId('studio-navigation');
    expect(nav).not.toHaveAttribute('role');
    expect(nav).not.toHaveAttribute('aria-modal');
    expect(nav).not.toHaveAttribute('aria-hidden');
  });

  it('takes focus onto an explicit way out, and closes on Escape', () => {
    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const close = screen.getByRole('button', { name: 'Close' });
    // First in DOM order on purpose: the open effect focuses the first control, and a sheet whose only
    // exits are the backdrop strip and picking a destination is one the keyboard cannot leave.
    expect(document.activeElement).toBe(close);
    // Counted from here: arriving somewhere already closes the sheet, so the mount itself reports one.
    const before = onClose.mock.calls.length;
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose.mock.calls.length).toBe(before + 1);
    fireEvent.click(close);
    expect(onClose.mock.calls.length).toBe(before + 2);
  });

  it('gives focus back to whatever opened it, but only while focus is still inside', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    // Opened by a re-render rather than mounted open, which is how the shell actually opens it.
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
    client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
    const view = render(<Wrapper><StudioNavigation drawer drawerOpen={false} onDrawerClose={onClose} /></Wrapper>);
    expect(document.activeElement).toBe(opener);

    view.rerender(<Wrapper><StudioNavigation drawer drawerOpen onDrawerClose={onClose} /></Wrapper>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));

    view.rerender(<Wrapper><StudioNavigation drawer drawerOpen={false} onDrawerClose={onClose} /></Wrapper>);
    expect(document.activeElement).toBe(opener);

    // Focus that has since moved elsewhere is the user's, not the sheet's to take back.
    view.rerender(<Wrapper><StudioNavigation drawer drawerOpen onDrawerClose={onClose} /></Wrapper>);
    (document.activeElement as HTMLElement).blur();
    view.rerender(<Wrapper><StudioNavigation drawer drawerOpen={false} onDrawerClose={onClose} /></Wrapper>);
    expect(document.activeElement).not.toBe(opener);

    opener.remove();
  });
});

describe('StudioNavigation fold control', () => {
  it('folds from Ctrl/Cmd + backslash, and leaves the command palette shortcut alone', () => {
    const onToggleCollapse = vi.fn();
    mount({ onToggleCollapse });
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true });
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
    // The palette owns Cmd/Ctrl+K, and a plain backslash is a character somebody is typing.
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash' });
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
  });

  it('announces the shortcut on the control, so it is discoverable without documentation', () => {
    const onToggleCollapse = vi.fn();
    mount({ onToggleCollapse });
    const control = screen.getByTestId('studio-nav-collapse');
    expect(control).toHaveAttribute('aria-keyshortcuts', 'Control+Backslash Meta+Backslash');
    expect(control.getAttribute('title')).toContain('Ctrl / ⌘ + \\');
    fireEvent.click(control);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('offers neither control nor shortcut where folding is not the user\'s call', () => {
    const onToggleCollapse = vi.fn();
    mount();
    expect(screen.queryByTestId('studio-nav-collapse')).toBeNull();
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});
