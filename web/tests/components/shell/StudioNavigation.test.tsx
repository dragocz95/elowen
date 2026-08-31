import { useState } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
const currentPath = vi.hoisted(() => ({ value: '/dash' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: vi.fn() }) }));
import { StudioNavigation } from '../../../components/shell/StudioNavigation';
import { Modal } from '../../../components/ui/Modal';
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
beforeEach(() => { localStorage.clear(); currentPath.value = '/dash'; savedLayouts.length = 0; });

/** A plugin contributing TWO pages is the only thing in the model that produces a group: one page is a
 *  plain destination, and a world naming a single child (projects) is not a disclosure worth drawing. */
function mount(
  props: Parameters<typeof StudioNavigation>[0] = {},
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

  it('reorders desktop destinations by dragging the row and persists the new layout', async () => {
    const { container } = mount();
    const rows = Array.from(container.querySelectorAll<HTMLDivElement>('.studio-nav__body [data-nav-entry-id]'));
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({
        x: 0, y: index * 40, top: index * 40, left: 0, right: 220,
        bottom: index * 40 + 32, width: 220, height: 32, toJSON: () => ({}),
      });
    });
    const home = screen.getByRole('link', { name: 'Home' }).closest<HTMLDivElement>('[data-nav-entry-id]')!;
    const chat = screen.getByRole('link', { name: 'Chat' }).closest<HTMLDivElement>('[data-nav-entry-id]')!;
    const homeId = home.dataset.navEntryId!;
    const chatId = chat.dataset.navEntryId!;
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('draggable', 'false');
    const homeIndex = rows.indexOf(home);
    const chatIndex = rows.indexOf(chat);

    fireEvent.pointerDown(home, { pointerType: 'mouse', button: 0, pointerId: 1, clientY: homeIndex * 40 + 16 });
    fireEvent.pointerMove(home, { pointerType: 'mouse', pointerId: 1, clientY: chatIndex * 40 + 16 });
    expect(home).toHaveAttribute('data-dragging', 'true');
    fireEvent.pointerUp(home, { pointerType: 'mouse', pointerId: 1, clientY: chatIndex * 40 + 16 });

    await waitFor(() => expect(savedLayouts).toHaveLength(1));
    expect(savedLayouts[0].order.indexOf(chatId)).toBeLessThan(savedLayouts[0].order.indexOf(homeId));
  });

  it('targets the persisted global order when footer entries are interleaved with destinations', async () => {
    const initial = {
      hidden: [],
      order: ['settings', 'home', 'chat', 'projects', 'memory', 'skills', 'work', 'users', 'account'],
    };
    const { container } = mount({}, initial);
    const rows = Array.from(container.querySelectorAll<HTMLDivElement>('.studio-nav__body [data-nav-entry-id]'));
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({
        x: 0, y: index * 40, top: index * 40, left: 0, right: 220,
        bottom: index * 40 + 32, width: 220, height: 32, toJSON: () => ({}),
      });
    });
    const home = screen.getByRole('link', { name: 'Home' }).closest<HTMLDivElement>('[data-nav-entry-id]')!;
    const chat = screen.getByRole('link', { name: 'Chat' }).closest<HTMLDivElement>('[data-nav-entry-id]')!;
    const homeIndex = rows.indexOf(home);
    const chatIndex = rows.indexOf(chat);

    fireEvent.pointerDown(home, { pointerType: 'mouse', button: 0, pointerId: 1, clientY: homeIndex * 40 + 16 });
    fireEvent.pointerMove(home, { pointerType: 'mouse', pointerId: 1, clientY: chatIndex * 40 + 16 });
    fireEvent.pointerUp(home, { pointerType: 'mouse', pointerId: 1, clientY: chatIndex * 40 + 16 });

    await waitFor(() => expect(savedLayouts).toHaveLength(1));
    expect(savedLayouts[0].order.slice(0, 3)).toEqual(['settings', 'chat', 'home']);
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

  it('names a destination in both modes, and keeps a tooltip on the icon column', () => {
    const expanded = mount();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('title', 'Home');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-label');
    expanded.unmount();

    mount({ compact: true });
    // The icon column drops the label text, so the accessible name has to come from the attribute — and
    // the tooltip has to stay: an unlabelled 16px glyph with nothing on hover is a guess, which is what
    // makes an icon sidebar unusable rather than compact.
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-label', 'Home');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('title', 'Home');
  });

  it('draws the account entry as the signed-in user, still named by what the entry is', () => {
    // The row shows a face and a display name, but it is still the `account` entry: the arrangement
    // menu addresses it by that name, and announcing the person twice instead would make the one row
    // that leads to your own settings the hardest one to find by name.
    mount();
    const account = screen.getByRole('link', { name: 'Account' });
    expect(account).toHaveAttribute('href', '/account');
    expect(account).toHaveAttribute('aria-label', 'Account');
    expect(account.textContent).toContain('admin');
  });
});

describe('StudioNavigation grouping', () => {
  it('keeps the desktop sidebar primary-only, linking a multi-page world through its default page', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Work' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Work' })).toHaveAttribute('href', '/p/work/board');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Timeline' })).toBeNull();
  });

  it('keeps the complete nested navigation in the mobile drawer', () => {
    mount({ drawer: true, drawerOpen: true, onDrawerClose: vi.fn() });
    const group = screen.getByRole('button', { name: 'Work' });
    expect(group).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute('href', '/p/work/board');
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/p/work/timeline');
    fireEvent.click(group);
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Timeline' })).toBeNull();
  });

  it('keeps the active drawer page visible when its group is folded shut', () => {
    currentPath.value = '/p/work/timeline';
    mount({ drawer: true, drawerOpen: true, onDrawerClose: vi.fn() });
    fireEvent.click(screen.getByRole('button', { name: 'Work' }));
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
  });

  it('keeps the compact desktop sidebar primary-only as well', () => {
    currentPath.value = '/p/work/timeline';
    mount({ compact: true });
    expect(screen.queryByRole('button', { name: 'Work' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Work' })).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('link', { name: 'Work' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Timeline' })).toBeNull();
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
    expect(open).not.toHaveAttribute('aria-labelledby');
    expect(open).not.toHaveAttribute('data-presentation');
    expect(open).not.toHaveAttribute('aria-hidden');
    expect(open).not.toHaveAttribute('inert');
  });

  it('lets Radix hide the page behind the open modal drawer', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
    client.setQueryData(['health'], { ok: true, version: '0.26.0' });
    client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
    client.setQueryData(['plugin-ui', 'en'], []);
    const view = render(
      <Wrapper>
        <main data-testid="drawer-background">Page</main>
        <StudioNavigation drawer drawerOpen onDrawerClose={onClose} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId('drawer-background')).toHaveAttribute('aria-hidden', 'true'));

    view.rerender(
      <Wrapper>
        <main data-testid="drawer-background">Page</main>
        <StudioNavigation drawer drawerOpen={false} onDrawerClose={onClose} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId('drawer-background')).not.toHaveAttribute('aria-hidden'));
  });

  it('keeps the drawer customization menu inside the Radix focus scope', async () => {
    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const drawer = screen.getByRole('dialog', { name: 'Primary' });
    const before = onClose.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Show hidden' }));
    const menu = await screen.findByRole('menu');
    expect(drawer).toContainElement(menu);
    expect(drawer).toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(before);
    await waitFor(() => expect(menu).toContainElement(document.activeElement as HTMLElement));
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
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose.mock.calls.length).toBe(before + 1);
    fireEvent.click(close);
    expect(onClose.mock.calls.length).toBe(before + 2);
  });

  it('leaves Escape and Tab to a modal raised above the drawer', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
    client.setQueryData(['health'], { ok: true, version: '0.26.0' });
    client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
    client.setQueryData(['plugin-ui', 'en'], []);

    function DrawerWithModal() {
      const [modalOpen, setModalOpen] = useState(true);
      return <>
        <StudioNavigation drawer drawerOpen onDrawerClose={onClose} />
        {modalOpen ? <Modal title="Raised dialog" onClose={() => setModalOpen(false)}><button type="button">Modal action</button></Modal> : null}
      </>;
    }

    render(<Wrapper><DrawerWithModal /></Wrapper>);
    const dialog = await screen.findByRole('dialog', { name: 'Raised dialog' });
    const modalAction = screen.getByRole('button', { name: 'Modal action' });
    modalAction.focus();
    const before = onClose.mock.calls.length;

    fireEvent.keyDown(modalAction, { key: 'Tab' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(before);

    fireEvent.keyDown(modalAction, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Raised dialog' })).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledTimes(before);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(before + 1);
  });

  /** The sheet's own tab order, read off the DOM rather than pinned to particular controls: the sheet
   *  renders whatever destinations the menu holds, and the trap has to hold at whichever ends it has. */
  function tabRing() {
    const nav = screen.getByTestId('studio-navigation');
    const items = Array.from(nav.querySelectorAll<HTMLElement>('a[href], button'));
    return { nav, first: items[0]!, last: items.at(-1)! };
  }

  it('keeps Tab inside the sheet, wrapping at both ends', () => {
    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const { first, last } = tabRing();
    expect(document.activeElement).toBe(first);

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back in when it has escaped the sheet, which aria-modal promises', () => {
    mount({ drawer: true, drawerOpen: true, onDrawerClose: onClose });
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(document.activeElement).toBe(tabRing().first);
    outside.remove();
  });

  it('gives focus back to the control that opened it', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
    client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });

    function ControlledDrawer() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open navigation</button>
          <StudioNavigation drawer drawerOpen={open} onDrawerClose={() => setOpen(false)} />
        </>
      );
    }

    render(<Wrapper><ControlledDrawer /></Wrapper>);
    const opener = screen.getByRole('button', { name: 'Open navigation' });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    await waitFor(() => expect(document.activeElement).toBe(opener));
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


  it('offers neither control nor shortcut where folding is not the user\'s call', () => {
    const onToggleCollapse = vi.fn();
    mount();
    expect(screen.queryByTestId('studio-nav-collapse')).toBeNull();
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});
