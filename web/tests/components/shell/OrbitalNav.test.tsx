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

function mount(compact = false) {
  const { wrapper: Wrapper, client } = createWrapper();
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
  return render(<Wrapper><OrbitalNav compact={compact} /></Wrapper>);
}

describe('orbital navigation geometry', () => {
  it('parks destinations in one fixed centered order', () => {
    expect(getStableOffsets(8, 66)).toEqual([-231, -165, -99, -33, 33, 99, 165, 231]);
  });
  it('tightens spacing only when the axis needs it', () => {
    expect(railSpacing(8, 845)).toBe(66);
    expect(railSpacing(12, 704)).toBeLessThan(66);
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
    expect(screen.getByTestId('future-navigation')).toHaveClass('w-[4.75rem]');
    expect(screen.getByRole('link', { name: 'Statistics' })).toBeInTheDocument();
  });
});
