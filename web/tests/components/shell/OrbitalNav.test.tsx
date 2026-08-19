import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
const pushSpy = vi.hoisted(() => vi.fn());
const currentPath = vi.hoisted(() => ({ value: '/p/work/stats' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: pushSpy }) }));
import { getStableOffsets, OrbitalNav, railSpacing } from '../../../components/shell/OrbitalNav';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/api/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());
beforeEach(() => localStorage.clear());

function mount(compact = false, props: { side?: 'left' | 'right'; onToggleCollapse?: () => void; drawer?: boolean; drawerOpen?: boolean; onDrawerClose?: () => void } = {}) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  client.setQueryData(['my-nav-settings'], { hidden: [], order: [] });
  // The work pages, Sessions and the Editor are plugin-supplied now — seed the /plugins/ui listing the
  // shell nav maps into worlds (key carries the locale; tests run with the default 'en').
  client.setQueryData(['plugin-ui', 'en'], [
    { name: 'work', nav: [
      { label: 'Tasks', icon: 'ListChecks', route: 'tasks' },
      { label: 'Kanban', icon: 'KanbanSquare', route: 'kanban' },
      { label: 'Timeline', icon: 'Activity', route: 'timeline' },
      { label: 'Stats', icon: 'BarChart3', route: 'stats' },
    ], settings: [] },
    { name: 'agents', nav: [{ label: 'Sessions', icon: 'SquareTerminal', route: 'sessions' }, { label: 'Escalations', icon: 'ShieldAlert', route: 'escalations' }], settings: [] },
    { name: 'editor', nav: [{ label: 'Editor', icon: 'Code2', route: '' }], settings: [] },
  ]);
  return render(<Wrapper><OrbitalNav compact={compact} {...props} /></Wrapper>);
}

/** The vertical offset a rail item is parked at, e.g. `translate(0, calc(-50% + -66px)) scale(.9)` → -66. */
function offsetOf(label: string): number {
  const style = screen.getByRole('link', { name: label }).closest('[role="listitem"]')!.getAttribute('style') ?? '';
  const match = /calc\(-50% \+ (-?[\d.]+)px\)/.exec(style);
  if (!match) throw new Error(`no offset in style: ${style}`);
  return Number(match[1]);
}

describe('getStableOffsets', () => {
  it('parks the rail in one fixed, centered visual order', () => {
    expect(getStableOffsets(8, 66)).toEqual([-231, -165, -99, -33, 33, 99, 165, 231]);
  });
});

describe('railSpacing', () => {
  it('uses the public rail spacing whenever the axis has room for it', () => {
    expect(railSpacing(12, 1000)).toBe(66);
    expect(railSpacing(8, 845)).toBe(66);
  });

  // A phone is the shortest axis there is, and the rail is its only menu now.
  it('seats the outermost destination fully on a phone-height axis', () => {
    const stage = 748; // a 844px phone viewport minus the rail's footer
    const offsets = getStableOffsets(12, railSpacing(12, stage));
    // The active node is the largest (4.65rem); half of it has to clear the end of the axis.
    expect(Math.abs(offsets[0]) + 37.2).toBeLessThanOrEqual(stage / 2);
  });

  it('tightens rather than clipping the end destinations on a short axis', () => {
    const stage = 704; // an 800px-tall window
    const spacing = railSpacing(12, stage);
    expect(spacing).toBeLessThan(66);
    // Every node, including the outermost, must still sit inside the axis.
    const offsets = getStableOffsets(12, spacing);
    expect(Math.abs(offsets[0]) + 40).toBeLessThanOrEqual(stage / 2);
  });

  it('falls back to the public spacing before the axis has been measured', () => {
    expect(railSpacing(12, 0)).toBe(66);
  });
});

describe('OrbitalNav rail stability', () => {
  it('keeps every destination at the same offset whichever route is active', () => {
    currentPath.value = '/p/work/stats';
    const first = mount();
    const parked = ['Projects', 'Editor', 'Stats', 'Memory', 'Users', 'Home'].map((l) => [l, offsetOf(l)] as const);
    first.unmount();

    // Navigating must not re-shuffle the rail: an item's parked offset is a property of the rail's
    // order, not of which item happens to be active — otherwise items slide past each other on every
    // route change, and the one wrapping the ends jumps with no transition at all.
    currentPath.value = '/users';
    mount();
    for (const [label, offset] of parked) expect([label, offsetOf(label)]).toEqual([label, offset]);
  });

  it('does not wrap the wheel around the ends of the rail', () => {
    currentPath.value = '/users'; // last route on the axis
    mount();
    pushSpy.mockClear();
    fireEvent.wheel(screen.getByTestId('future-navigation'), { deltaY: 60 });
    expect(pushSpy).not.toHaveBeenCalled(); // clamped, never wrapped back to the first route
  });

  it('runs home → work → context → administration down the axis', () => {
    currentPath.value = '/dash';
    mount();
    const order = screen.getAllByRole('listitem')
      .map((item) => [item.querySelector('a')!.textContent, offsetOf(item.querySelector('a')!.textContent!)] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([label]) => label);
    // The whole axis, not just its ends: a destination whose address the order does not name falls
    // past administration to the very bottom, and no other assertion here would notice. Extracting
    // the work pages into a plugin changed all four of their addresses — this is what catches it.
    expect(order).toEqual([
      'Home', 'Chat',
      'Tasks', 'Kanban', 'Sessions', 'Timeline',
      'Projects', 'Editor', 'Memory', 'Stats',
      'Account', 'Settings', 'Users',
    ]);
  });
});

describe('OrbitalNav', () => {
  beforeEach(() => { currentPath.value = '/p/work/stats'; });

  it('exposes work and project destinations as top-level orbital links', () => {
    mount();
    // The rail is real links and DOM, never the WebGL orbit scene it started as — that scene is gone and
    // must not come back. Asserted on the scene itself rather than on "no canvas at all", which also
    // forbade the ambient ember drizzle the rail deliberately carries.
    expect(screen.queryByTestId('orbit-webgl')).toBeNull();
    expect(screen.getByTestId('future-navigation').querySelector('canvas.ember-fall')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Elowen' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Chat' })).toHaveAttribute('href', '/chat');
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/p/work/tasks');
    expect(screen.getByRole('link', { name: 'Kanban' })).toHaveAttribute('href', '/p/work/kanban');
    expect(screen.getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/p/agents/sessions');
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/p/work/timeline');
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: 'Editor' })).toHaveAttribute('href', '/p/editor');
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users');
    expect(screen.queryByRole('link', { name: 'Work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'System' })).toBeNull();
  });

  it('keeps a link stable under the pointer so one click can navigate', () => {
    mount();
    const projects = screen.getByRole('link', { name: 'Projects' });
    const before = projects.closest('[role="listitem"]')?.getAttribute('style');
    fireEvent.focus(projects);
    expect(projects.closest('[role="listitem"]')?.getAttribute('style')).toBe(before);
    expect(projects).toHaveAttribute('href', '/projects');
  });

  it('steps to the next route when the wheel is used over navigation', () => {
    mount(); // active: the spend stats — the last "context" stop before administration
    fireEvent.wheel(screen.getByTestId('future-navigation'), { deltaY: 60 });
    expect(pushSpy).toHaveBeenCalledWith('/account');
  });

  it('renders the scroll cue above the version', () => {
    mount();
    expect(screen.getByText('SCROLL')).toBeInTheDocument();
    expect(screen.getByText('v0.26.0')).toBeInTheDocument();
  });

  it('keeps every destination on one vertical orbital rail', () => {
    mount();
    const users = screen.getByRole('link', { name: 'Users' });
    expect(users).not.toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('future-navigation')).toHaveClass('w-[17rem]');
    expect(users.closest('[role="listitem"]')).toHaveClass('absolute');
    const origins = screen.getAllByRole('listitem').map((item) => item.style.transformOrigin);
    expect(new Set(origins)).toEqual(new Set(['2.5rem center']));
  });

  it('does not move controls under the pointer', () => {
    mount();
    const projects = screen.getByRole('link', { name: 'Projects' }).closest('[role="listitem"]');
    const before = projects?.className;
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Projects' }));
    expect(projects?.className).toBe(before);
  });

  it('collapses to an icon orbit when content room is constrained', () => {
    mount(true);
    expect(screen.getByTestId('future-navigation')).toHaveClass('w-[4.75rem]');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('OrbitalNav collapse handle', () => {
  beforeEach(() => { currentPath.value = '/p/work/stats'; });

  it('is absent when collapsing is not the user’s call, so no dead control is offered', () => {
    mount();
    expect(screen.queryByTestId('nav-collapse-handle')).toBeNull();
  });

  it('collapses the rail on click and says so — the label flips to the way back out', () => {
    const toggle = vi.fn();
    const { rerender } = mount(false, { onToggleCollapse: toggle });
    const handle = screen.getByTestId('nav-collapse-handle');
    expect(handle).toHaveAccessibleName('Collapse navigation to icons');
    fireEvent.click(handle);
    expect(toggle).toHaveBeenCalledTimes(1);

    const { wrapper: Wrapper } = createWrapper();
    rerender(<Wrapper><OrbitalNav compact onToggleCollapse={toggle} /></Wrapper>);
    expect(screen.getByTestId('nav-collapse-handle')).toHaveAccessibleName('Expand navigation');
  });

  // The rail mirrors to the right edge when the dock takes the left one. The handle belongs on the seam
  // with the content either way — pinned to the wrong edge it would sit against the window frame.
  it('rides the edge facing the content, whichever side the rail is on', () => {
    const { unmount } = mount(false, { side: 'left', onToggleCollapse: () => {} });
    expect(screen.getByTestId('nav-collapse-handle')).toHaveClass('right-0');
    unmount();
    mount(false, { side: 'right', onToggleCollapse: () => {} });
    expect(screen.getByTestId('nav-collapse-handle')).toHaveClass('left-0');
  });
});

describe('OrbitalNav long labels', () => {
  beforeEach(() => { currentPath.value = '/p/work/stats'; });

  // The selected entry renders ~40% larger than the others, so a label that fits at rest can outgrow the
  // fixed-width rail once it is clicked — and the rail's `overflow-hidden` cut it off mid-word with no
  // ellipsis and no way to read the rest. Plugin labels are translated by their own authors, so the rail
  // cannot assume any length.
  it('lets a label shrink to an ellipsis and keeps the full text in the title', () => {
    mount();
    const link = screen.getByRole('link', { name: 'Stats' });
    const label = link.lastElementChild as HTMLElement; // the icon orbit is first, the text last

    expect(link.getAttribute('title')).toBe('Stats');
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('min-w-0');
  });
});

// The rail is what the desktop actually renders — the sidebar only ever appears as the mobile drawer.
// Wiring the customization menu into the sidebar alone left the feature unreachable for every desktop
// user, which is exactly the gap these tests close.
describe('OrbitalNav menu customization', () => {
  beforeEach(() => { currentPath.value = '/p/work/stats'; });

  it('offers hide and reorder on a destination, addressed by the world it belongs to', () => {
    mount();
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Memory' }));

    expect(screen.getByText('Hide')).toBeInTheDocument();
    expect(screen.getByText('Move up')).toBeInTheDocument();
    expect(screen.getByText('Move down')).toBeInTheDocument();
    // Everything the menu can do is in the menu; there is no editor to send the reader off to.
    expect(screen.getByText('Restore default order')).toBeInTheDocument();
  });

  it('offers no hiding on a system destination, which the layout must not be able to remove', () => {
    mount();
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Settings' }));

    expect(screen.getByText('Restore default order')).toBeInTheDocument();
    expect(screen.queryByText('Hide')).not.toBeInTheDocument();
    expect(screen.queryByText('Move up')).not.toBeInTheDocument();
  });

  // Hiding is one click; getting a space back must not be harder. The hidden ones hang off the same
  // menu, because there is nowhere else to look for them.
  it('lists the hidden spaces in the menu so they can come back', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
    client.setQueryData(['health'], { ok: true, version: '0.26.0' });
    client.setQueryData(['plugin-ui', 'en'], []);
    client.setQueryData(['my-nav-settings'], { hidden: ['memory'], order: [] });
    render(<Wrapper><OrbitalNav /></Wrapper>);

    fireEvent.contextMenu(screen.getByRole('navigation'));
    fireEvent.click(screen.getByText('Hidden (1)'));
    expect(await screen.findByText('Memory')).toBeInTheDocument();
  });

  it('drops a hidden world from the rail', () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
    client.setQueryData(['health'], { ok: true, version: '0.26.0' });
    client.setQueryData(['plugin-ui', 'en'], []);
    client.setQueryData(['my-nav-settings'], { hidden: ['memory'], order: [] });
    render(<Wrapper><OrbitalNav /></Wrapper>);

    expect(screen.queryByRole('link', { name: 'Memory' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });
});

describe('OrbitalNav order stability', () => {
  beforeEach(() => { currentPath.value = '/dash'; });

  const railLabels = () => [...document.querySelector('[data-testid="future-navigation"]')!
    .querySelectorAll('[role="listitem"] a')].map((link) => (link.getAttribute('title') ?? link.textContent ?? '').trim());

  // The stored order starts empty, so the first edit seeds it — and if it seeds from the registry
  // instead of from what the rail is showing, hiding one space silently re-sorts every other one.
  // That is exactly what the rail looked like in use: touch it once and the whole menu jumps.
  it('hiding one space leaves every other one exactly where it was', async () => {
    server.use(http.patch('*/api/auth/me/nav-settings', async ({ request }) => HttpResponse.json(await request.json())));
    mount();
    const before = railLabels();
    expect(before).toContain('Memory');

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Memory' }));
    fireEvent.click(screen.getByText('Hide'));

    await waitFor(() => expect(screen.queryByRole('link', { name: 'Memory' })).not.toBeInTheDocument());
    expect(railLabels()).toEqual(before.filter((label) => label !== 'Memory'));
  });
});

/** On a phone the same rail slides in over the page. It is the ONLY menu now — the separate sidebar
 *  drawer is gone — so everything the old one carried has to be reachable here, by finger. */
describe('OrbitalNav as a phone drawer', () => {
  beforeEach(() => { currentPath.value = '/dash'; });

  const nav = () => document.querySelector('[data-testid="future-navigation"]')!;

  it('sits off-screen and inert until it is opened', () => {
    mount(false, { drawer: true, drawerOpen: false });
    expect(nav().className).toContain('-translate-x-full');
    expect(nav().hasAttribute('inert')).toBe(true);
    expect(nav().getAttribute('aria-hidden')).toBe('true');
  });

  it('slides in and becomes reachable once opened', () => {
    mount(false, { drawer: true, drawerOpen: true });
    expect(nav().className).toContain('translate-x-0');
    expect(nav().hasAttribute('inert')).toBe(false);
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  // Covering the whole screen would remove both the signal that this is a layer over the page and the
  // target that dismisses it.
  it('stops short of the full width, leaving backdrop to tap', () => {
    mount(false, { drawer: true, drawerOpen: true });
    expect(nav().className).toContain('w-[min(20rem,85vw)]');
    expect(nav().className).not.toContain('w-full');
  });

  it('is dismissed by tapping the backdrop', () => {
    const onDrawerClose = vi.fn();
    mount(false, { drawer: true, drawerOpen: true, onDrawerClose });
    const backdrop = document.querySelector('.fixed.inset-0')!;
    fireEvent.click(backdrop);
    expect(onDrawerClose).toHaveBeenCalled();
  });

  it('reports the daemon state the old sidebar used to carry', () => {
    mount(false, { drawer: true, drawerOpen: true });
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Ready');
  });
});

/** Reordering happens ON the rail: grab a space and carry it. The browser's own link dragging is what
 *  a user hits first if this is not wired, which is exactly what happened. */
describe('OrbitalNav dragging a space', () => {
  beforeEach(() => { currentPath.value = '/dash'; });

  const railLabels = () => [...document.querySelectorAll('[data-testid="future-navigation"] [role="listitem"] a')]
    .map((link) => (link.getAttribute('title') ?? link.textContent ?? '').trim());

  const rowOf = (label: string) => screen.getByRole('link', { name: label }).closest('[role="listitem"]') as HTMLElement;

  function carry(label: string, dy: number, pointerType: 'mouse' | 'touch' = 'mouse') {
    const row = rowOf(label);
    row.setPointerCapture = () => {};
    row.releasePointerCapture = () => {};
    const opts = (y: number) => ({ bubbles: true, cancelable: true, pointerId: 1, pointerType, button: 0, clientX: 20, clientY: y });
    fireEvent.pointerDown(row, opts(400));
    fireEvent.pointerMove(row, opts(400 + dy));
    return { row, drop: () => fireEvent.pointerUp(row, opts(400 + dy)) };
  }

  it('leaves the browser to do nothing of its own with the link', () => {
    mount();
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('draggable', 'false');
  });

  /** The vertical offset the row is parked at, straight out of its transform. */
  const offsetOf = (row: HTMLElement) => {
    const match = /calc\(-50% \+ (-?[\d.]+)px\)/.exec(row.getAttribute('style') ?? '');
    if (!match) throw new Error(`no offset in style: ${row.getAttribute('style')}`);
    return Number(match[1]);
  };

  it('carries the space with the pointer while it is held', () => {
    mount();
    const atRest = offsetOf(rowOf('Home'));
    const { row } = carry('Home', 120);
    expect(row.getAttribute('data-dragging')).toBe('true');
    expect(offsetOf(row) - atRest).toBe(120);
  });

  it('makes its neighbours step aside to open the gap it will land in', () => {
    mount();
    const neighbour = rowOf('Chat');
    const atRest = offsetOf(neighbour);
    carry('Home', 200);
    expect(offsetOf(neighbour)).toBeLessThan(atRest);
  });

  // Without a threshold every click would be a one-pixel drag and navigation would stop working.
  it('treats a small movement as a click, not a drag', () => {
    mount();
    const { row } = carry('Home', 3);
    expect(row.hasAttribute('data-dragging')).toBe(false);
  });

  it('commits the new order when the space is dropped', async () => {
    const patches: unknown[] = [];
    server.use(http.patch('*/api/auth/me/nav-settings', async ({ request }) => {
      const body = await request.json();
      patches.push(body);
      return HttpResponse.json(body);
    }));
    mount();
    const before = railLabels();
    const { drop } = carry('Home', 200);
    drop();

    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() => expect(railLabels()).not.toEqual(before));
    expect(railLabels()).toContain('Home');
  });

  it('does not write anything when the space is dropped where it started', () => {
    const patches: unknown[] = [];
    server.use(http.patch('*/api/auth/me/nav-settings', async ({ request }) => {
      patches.push(await request.json());
      return HttpResponse.json({ hidden: [], order: [] });
    }));
    mount();
    const { drop } = carry('Home', 8);
    drop();
    expect(patches).toEqual([]);
  });

  // A drag whose click never arrives (released off the row, or a browser that synthesises none) must
  // not leave anything armed: the next click would be eaten and navigation would just stop working.
  it('still navigates on the click after a drag that produced none', () => {
    mount();
    carry('Home', 200).drop();

    // A real click always begins with a press on the row it lands on.
    const row = rowOf('Chat');
    row.setPointerCapture = () => {};
    const at = { bubbles: true, pointerId: 9, button: 0, clientX: 20, clientY: 400 };
    fireEvent.pointerDown(row, at);
    fireEvent.pointerUp(row, at);

    const link = screen.getByRole('link', { name: 'Chat' });
    const click = createEvent.click(link, { bubbles: true, cancelable: true });
    fireEvent(link, click);
    expect(click.defaultPrevented).toBe(false);
  });

  // Touch has no right-click, so holding still is how a finger reaches hide and the hidden spaces.
  it('opens the same menu on a long press', async () => {
    vi.useFakeTimers();
    try {
      mount();
      const row = rowOf('Home');
      row.setPointerCapture = () => {};
      // jsdom's synthetic pointer events carry no pointerType of their own, and the long press is armed
      // for touch alone — a mouse held still is not asking for anything.
      const press = createEvent.pointerDown(row, { bubbles: true, clientX: 20, clientY: 400 });
      Object.defineProperty(press, 'pointerType', { get: () => 'touch' });
      fireEvent(row, press);
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.getByText('Hide')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
