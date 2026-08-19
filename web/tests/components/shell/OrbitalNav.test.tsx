import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
const pushSpy = vi.hoisted(() => vi.fn());
const currentPath = vi.hoisted(() => ({ value: '/p/work/stats' }));
vi.mock('next/navigation', () => ({ usePathname: () => currentPath.value, useRouter: () => ({ push: pushSpy }) }));
import { getStableOffsets, OrbitalNav, railSpacing } from '../../../components/shell/OrbitalNav';
import { createWrapper } from '../../test-utils';

function mount(compact = false, props: { side?: 'left' | 'right'; onToggleCollapse?: () => void } = {}) {
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
    expect(screen.getByText('Customize menu…')).toBeInTheDocument();
  });

  it('offers only the editor on a system destination, which the layout must not be able to hide', () => {
    mount();
    fireEvent.contextMenu(screen.getByRole('link', { name: 'Settings' }));

    expect(screen.getByText('Customize menu…')).toBeInTheDocument();
    expect(screen.queryByText('Hide')).not.toBeInTheDocument();
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
