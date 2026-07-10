import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
    expect(screen.queryByRole('link', { name: 'Work' })).toBeNull();
    expect(screen.getByRole('button', { name: 'System' })).toBeInTheDocument();
  });

  it('rotates focus without navigating and magnetically anchors the next destination', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('link', { name: 'Projects' }).closest('[role="listitem"]')).toHaveStyle({ opacity: '1' });
  });

  it('magnetically advances one world for a deliberate wheel gesture', () => {
    mount();
    fireEvent.wheel(screen.getByTestId('future-navigation'), { deltaY: 60 });
    expect(screen.getByRole('link', { name: 'Projects' }).closest('[role="listitem"]')).toHaveStyle({ opacity: '1' });
  });

  it('stages distant wrap-around items outside the visible curve', () => {
    mount();
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('tabindex', '-1');
    expect(home.closest('[role="listitem"]')).toHaveStyle({ opacity: '0', pointerEvents: 'none' });
  });

  it('does not move controls under the pointer and opens button-only groups on click', () => {
    mount();
    const projects = screen.getByRole('link', { name: 'Projects' }).closest('[role="listitem"]');
    const before = projects?.getAttribute('style');
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Projects' }));
    expect(projects?.getAttribute('style')).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByText('Account').closest('.orbit-branch')).toBeTruthy();
  });

  it('collapses to an icon orbit when content room is constrained', () => {
    mount(true);
    expect(screen.getByTestId('future-navigation')).toHaveClass('w-36');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
  });
});
