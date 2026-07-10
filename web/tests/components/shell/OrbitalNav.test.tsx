import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('next/navigation', () => ({ usePathname: () => '/stats' }));
import { OrbitalNav } from '../../../components/shell/OrbitalNav';
import { createWrapper } from '../../test-utils';

function mount(compact = false) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  client.setQueryData(['health'], { ok: true, version: '0.26.0' });
  return render(<Wrapper><OrbitalNav compact={compact} /></Wrapper>);
}

describe('OrbitalNav', () => {
  it('exposes work and project destinations as top-level orbital links', () => {
    mount();
    expect(screen.getByTestId('future-navigation').querySelector('canvas')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Elowen' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('href', '/tasks');
    expect(screen.getByRole('link', { name: 'Kanban' })).toHaveAttribute('href', '/kanban');
    expect(screen.getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/sessions');
    expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/timeline');
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: 'Editor' })).toHaveAttribute('href', '/editor');
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/users');
    expect(screen.queryByRole('link', { name: 'Work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'System' })).toBeNull();
  });

  it('rotates focus without navigating and magnetically anchors the next destination', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Projects' }).closest('[role="listitem"]')).toHaveStyle({ opacity: '1' }));
  });

  it('magnetically advances one world for a deliberate wheel gesture', async () => {
    mount();
    fireEvent.wheel(screen.getByTestId('future-navigation'), { deltaY: 60 });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Projects' }).closest('[role="listitem"]')).toHaveStyle({ opacity: '1' }));
  });

  it('places the opposite item at the rear of the spherical path', () => {
    mount();
    const users = screen.getByRole('link', { name: 'Users' });
    expect(users).not.toHaveAttribute('tabindex', '-1');
    expect(users.closest('[role="listitem"]')).toHaveStyle({ opacity: '0.28', filter: 'blur(1.15px)' });
    expect(users.closest('[role="listitem"]')?.getAttribute('style')).toContain('translateZ(-45px)');
  });

  it('does not move controls under the pointer', () => {
    mount();
    const projects = screen.getByRole('link', { name: 'Projects' }).closest('[role="listitem"]');
    const before = projects?.getAttribute('style');
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Projects' }));
    expect(projects?.getAttribute('style')).toBe(before);
  });

  it('collapses to an icon orbit when content room is constrained', () => {
    mount(true);
    expect(screen.getByTestId('future-navigation')).toHaveClass('w-36');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
  });
});
