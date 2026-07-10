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
  it('keeps real links in the orbital navigation and exposes the active world children', () => {
    mount();
    expect(screen.getByTestId('future-navigation').querySelector('canvas')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Elowen' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Work' })).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('link', { name: 'Stats' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'System' })).toBeInTheDocument();
  });

  it('rotates focus without navigating and reveals the next world hierarchy', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('link', { name: 'Editor' })).toHaveAttribute('href', '/editor');
  });

  it('magnetically advances one world for a deliberate wheel gesture', () => {
    mount();
    fireEvent.wheel(screen.getByTestId('future-navigation'), { deltaY: 60 });
    expect(screen.getByRole('link', { name: 'Editor' })).toHaveAttribute('href', '/editor');
  });

  it('does not move controls under the pointer and opens button-only groups on click', () => {
    mount();
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Projects' }));
    expect(screen.queryByRole('link', { name: 'Editor' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByText('Account').closest('.orbit-branch')).toBeTruthy();
  });

  it('collapses to an icon orbit when content room is constrained', () => {
    mount(true);
    expect(screen.getByTestId('future-navigation')).toHaveClass('w-36');
    expect(screen.queryByRole('link', { name: 'Stats' })).toBeNull();
  });
});
