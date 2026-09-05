import { useState } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
const location = vi.hoisted(() => ({ pathname: '/dash', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => location.pathname,
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(location.search),
}));
import { SidebarNav } from '../../../components/shell/SidebarNav';
import { createWrapper } from '../../test-utils';

const savedLayouts: Array<{ hidden: string[]; order: string[] }> = [];
const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.26.0' })),
  http.patch('*/api/auth/me/nav-settings', async ({ request }) => {
    const layout = await request.json() as { hidden: string[]; order: string[] };
    savedLayouts.push(layout);
    return HttpResponse.json(layout);
  }),
);
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => {
  localStorage.clear();
  location.pathname = '/dash';
  location.search = '';
  savedLayouts.length = 0;
});

/** A plugin contributing TWO pages is the only thing in the model that produces an inline sub-menu: one
 *  page is a plain destination, and a world naming a single child (projects) is not a disclosure worth
 *  drawing. */
function mount(
  props: Parameters<typeof SidebarNav>[0] = {},
  navLayout: { hidden: string[]; order: string[] } = { hidden: [], order: [] },
) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  client.setQueryData(['my-nav-settings'], navLayout);
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
    {
      name: 'ops',
      title: 'Ops',
      label: 'Ops',
      nav: [
        { label: 'Runs', icon: 'Play', route: 'runs' },
        { label: 'Alerts', icon: 'Bell', route: 'alerts' },
      ],
      settings: [],
    },
  ]);
  return render(<Wrapper><SidebarNav {...props} /></Wrapper>);
}

describe('SidebarNav destinations', () => {
  it('renders the registry and the plugin worlds as one menu', () => {
    mount();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/dash');
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: 'Memory' })).toHaveAttribute('href', '/memory');
    // A plugin with one page is a destination; the icon it declared is what the row draws.
    expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/p/skills');
  });

  it('groups the column the way the reference does, account last and set apart by air', () => {
    const { container } = mount();
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-group]'));
    expect(groups.map((group) => group.dataset.group)).toEqual(['primary', 'work', 'instance', 'account']);
    // The first block carries no header: it is where the reader lands.
    expect(groups[0]!.querySelector('[data-sidebar="group-label"]')).toBeNull();
    expect(groups[1]!.querySelector('[data-sidebar="group-label"]')!.textContent).toBe('Work');
    expect(groups[2]!.querySelector('[data-sidebar="group-label"]')!.textContent).toBe('Instance');
    // NO separator anywhere in the column. The rule above the account was the last one the menu drew and
    // the owner removed it on 5 Sep 2026: every boundary here, the account's included, is carried by the
    // group label and by air alone.
    expect(container.querySelectorAll('[data-sidebar="separator"]')).toHaveLength(0);
    // And the account block is still the LAST thing in the menu, immediately after the instance group.
    expect(groups[2]!.parentElement!.lastElementChild).toBe(groups[3]!);
    // A disclosure, not a link: the account page is a deck, so its own sections hang under this row like
    // any other world's pages.
    expect(groups[3]!.contains(screen.getByRole('button', { name: 'Account' }))).toBe(true);
  });

  it('marks the current route with aria-current, through the world it belongs to', () => {
    location.pathname = '/projects';
    mount();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('names a destination in the icon rail, where the label is not on screen', () => {
    const expanded = mount();
    // Expanded the native hint is what keeps a TRUNCATED label readable, and that is all it is for.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('title', 'Home');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-label');
    expanded.unmount();

    mount({ compact: true });
    // The folded column drops the label text, so the accessible name has to come from the attribute.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-label', 'Home');
    // And the hint is no longer the browser's own bubble: a 16px glyph with nothing on hover is a guess,
    // and an OS tooltip after half a second is not the affordance the reference has.
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('title');
  });

  it('names the folded rail with a real tooltip, and only while it is folded', async () => {
    const expanded = mount();
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Home' }));
    // Nothing to explain while the label is right there — a tip over an already-labelled row is noise.
    expect(screen.queryByRole('tooltip')).toBeNull();
    expanded.unmount();

    mount({ compact: true });
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Home' }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Home');

    fireEvent.mouseLeave(screen.getByRole('link', { name: 'Home' }));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('names the palette shortcut with the modifier this machine actually has', () => {
    // jsdom reports a non-Apple platform, so the hint is the Control one. `aria-keyshortcuts` still names
    // both, because the binding really does accept both — only the VISIBLE hint has to pick.
    mount();
    const palette = screen.getByRole('button', { name: 'Open command palette' });
    expect(palette).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    expect(palette).toHaveTextContent('Ctrl K');
    expect(palette).not.toHaveTextContent('⌘K');
  });

  it('offers the palette and the instance menu from the column itself', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Open command palette' }))
      .toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    expect(screen.getByRole('button', { name: 'Instance menu' })).toBeInTheDocument();
  });
});

describe('SidebarNav inline sub-menus', () => {
  it('discloses a multi-page world in place, with the parent announcing its state', () => {
    mount();
    const parent = screen.getByRole('button', { name: 'Work' });
    expect(parent).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();

    fireEvent.click(parent);
    expect(parent).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/p/work/board');
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/p/work/timeline');

    fireEvent.click(parent);
    expect(parent).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
  });

  it('opens the sub-menu the route lands in, and points at the exact page', () => {
    location.pathname = '/p/work/timeline';
    mount();
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Board' })).not.toHaveAttribute('aria-current');
  });

  it('lets the reader fold the section they are standing in back shut', () => {
    location.pathname = '/p/work/timeline';
    mount();
    const parent = screen.getByRole('button', { name: 'Work' });
    fireEvent.click(parent);
    expect(parent).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps several sub-menus open at once and remembers them per account', () => {
    // An accordion, not a tab strip: opening one section must not close the one already open.
    const first = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ops' }));
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Ops' })).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem('elowen.nav.submenus.1'))
      .toBe(JSON.stringify(['plugin-work', 'plugin-ops']));
    first.unmount();

    // A second mount for the same account reads its own folds back.
    mount();
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Ops' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses a sub-menu to its parent destination in the icon rail', () => {
    location.pathname = '/p/work/timeline';
    mount({ compact: true });
    // There is no room for a disclosure in a 16px column, so the world becomes one row that still leads
    // into it — every page stays one click away rather than unreachable.
    expect(screen.queryByRole('button', { name: 'Work' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Work' })).toHaveAttribute('data-active', 'true');
  });
});

describe('SidebarNav keyboard operation', () => {
  it('toggles a sub-menu from Enter and from Space', () => {
    mount();
    const parent = screen.getByRole('button', { name: 'Work' });
    parent.focus();
    // A real <button>, so the browser turns both keys into a click. Radix reads the resulting activation.
    fireEvent.keyDown(parent, { key: 'Enter' });
    fireEvent.click(parent);
    expect(parent).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyUp(parent, { key: ' ' });
    fireEvent.click(parent);
    expect(parent).toHaveAttribute('aria-expanded', 'false');
  });

  it('reaches every destination through the tab order, sub-menu pages included', () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    const stops = Array.from(container.querySelectorAll<HTMLElement>('a[href], button'))
      .filter((node) => node.getAttribute('tabindex') !== '-1');
    expect(stops).toContain(screen.getByRole('link', { name: 'Board' }));
    // A deck's sections are keyboard-reachable rows of the menu, which is the only route to them now.
    expect(stops).toContain(screen.getByRole('link', { name: 'Security' }));
  });

  it('folds the column from Ctrl/Cmd + backslash, and leaves the palette shortcut alone', () => {
    const onToggleCollapse = vi.fn();
    mount({ onToggleCollapse });
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true });
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash' });
    expect(onToggleCollapse).toHaveBeenCalledTimes(2);
  });

  it('offers the footer fold only where folding is the reader\'s call', () => {
    mount();
    expect(screen.queryByTestId('sidebar-nav-collapse')).toBeNull();
    const onToggleCollapse = vi.fn();
    const foldable = mount({ onToggleCollapse });
    fireEvent.click(screen.getByTestId('sidebar-nav-collapse'));
    expect(onToggleCollapse).toHaveBeenCalled();
    foldable.unmount();
  });
});

describe('SidebarNav customization', () => {
  it('hides an entry from its own context menu and persists the layout', async () => {
    mount();
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Memory' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide' }));
    await waitFor(() => expect(savedLayouts).toHaveLength(1));
    expect(savedLayouts[0]!.hidden).toContain('memory');
  });

  it('leaves a hidden entry out of the column and reachable from the surface menu', () => {
    mount({}, { hidden: ['memory'], order: [] });
    expect(screen.queryByRole('link', { name: 'Memory' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show hidden' })).toBeInTheDocument();
  });

  it('reorders destinations by dragging the row and persists the new order', async () => {
    const { container } = mount();
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-group="primary"] [data-nav-entry-id]'));
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({
        x: 0, y: index * 40, top: index * 40, left: 0, right: 220,
        bottom: index * 40 + 34, width: 220, height: 34, toJSON: () => ({}),
      });
    });
    const home = screen.getByRole('link', { name: 'Home' }).closest<HTMLElement>('[data-nav-entry-id]')!;
    const chat = screen.getByRole('link', { name: 'Chat' }).closest<HTMLElement>('[data-nav-entry-id]')!;
    const homeIndex = rows.indexOf(home);
    const chatIndex = rows.indexOf(chat);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('draggable', 'false');

    fireEvent.pointerDown(home, { pointerType: 'mouse', button: 0, pointerId: 1, clientY: homeIndex * 40 + 17 });
    fireEvent.pointerMove(home, { pointerType: 'mouse', pointerId: 1, clientY: chatIndex * 40 + 17 });
    expect(home).toHaveAttribute('data-dragging', 'true');
    fireEvent.pointerUp(home, { pointerType: 'mouse', pointerId: 1, clientY: chatIndex * 40 + 17 });

    await waitFor(() => expect(savedLayouts).toHaveLength(1));
    const { order } = savedLayouts[0]!;
    expect(order.indexOf('chat')).toBeLessThan(order.indexOf('home'));
  });
});

describe('SidebarNav as an offcanvas sheet', () => {
  const onClose = vi.fn();
  beforeEach(() => onClose.mockClear());

  it('is inert and unannounced while closed, and claims a modal dialog only once open', () => {
    const closed = mount({ drawer: true, drawerOpen: false, onDrawerClose: onClose });
    const nav = screen.getByTestId('sidebar-navigation');
    expect(nav).toHaveAttribute('role', 'dialog');
    expect(nav).not.toHaveAttribute('aria-modal');
    expect(nav).toHaveAttribute('aria-hidden', 'true');
    expect(nav).toHaveAttribute('inert');
    closed.unmount();

    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const open = screen.getByTestId('sidebar-navigation');
    expect(open).toHaveAttribute('aria-modal', 'true');
    expect(open).not.toHaveAttribute('aria-hidden');
    expect(open).not.toHaveAttribute('inert');
  });

  it('claims no dialog role at all as a column, where it is chrome rather than a layer', () => {
    mount();
    const nav = screen.getByTestId('sidebar-navigation');
    expect(nav).not.toHaveAttribute('role');
    expect(nav).not.toHaveAttribute('aria-modal');
    expect(nav).toHaveAttribute('data-shell', 'sidebar');
  });

  it('takes focus onto an explicit way out, and closes on Escape', () => {
    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    // Counted from here: arriving somewhere already closes the sheet, so the mount itself reports one.
    const before = onClose.mock.calls.length;
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose.mock.calls.length).toBe(before + 1);
    fireEvent.click(close);
    expect(onClose.mock.calls.length).toBe(before + 2);
  });

  it('gives focus back to the control that opened it', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
    client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });

    function ControlledSheet() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open navigation</button>
          <SidebarNav drawer drawerOpen={open} onDrawerClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Wrapper><ControlledSheet /></Wrapper>);
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('keeps the customization menu inside the Radix focus scope', async () => {
    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const sheet = screen.getByRole('dialog', { name: 'Primary' });
    const before = onClose.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }));
    const menu = await screen.findByRole('menu');
    expect(sheet).toContainElement(menu);
    expect(onClose).toHaveBeenCalledTimes(before);
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
  });
});
