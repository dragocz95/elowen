import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
vi.mock('next/navigation', () => ({
  usePathname: () => '/dash',
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
import { TopBar } from '../../../components/shell/TopBar';
import { createWrapper } from '../../test-utils';

function mount(props: Parameters<typeof TopBar>[0] = {}) {
  const { wrapper: Wrapper, client } = createWrapper();
  client.setQueryData(['me'], { user: { id: 1, username: 'admin', is_admin: true } });
  return render(<TopBar variant="bar" {...props} />, { wrapper: Wrapper });
}

/** The bar is the app's ONE fold control — the sidebar footer deliberately carries no second one — so the
 *  shortcut it announces has to live on this button's title. */
describe('TopBar fold control', () => {
  it('folds the column and names the keyboard shortcut beside the action', () => {
    const onNavToggle = vi.fn();
    mount({ onNavToggle });
    const toggle = screen.getByTestId('top-bar-nav-collapse');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse navigation to icons');
    expect(toggle.getAttribute('title')).toBe('Collapse navigation to icons · Ctrl / ⌘ + \\');
    expect(toggle.getAttribute('aria-keyshortcuts')).toBe('Control+Backslash Meta+Backslash');
    fireEvent.click(toggle);
    expect(onNavToggle).toHaveBeenCalledTimes(1);
  });

  it('reads as expand once the column is folded', () => {
    mount({ onNavToggle: vi.fn(), navCollapsed: true });
    const toggle = screen.getByTestId('top-bar-nav-collapse');
    expect(toggle.getAttribute('aria-label')).toBe('Expand navigation');
    expect(toggle.getAttribute('title')).toBe('Expand navigation · Ctrl / ⌘ + \\');
  });

  it('withholds the control where folding is not the reader\'s call', () => {
    mount();
    expect(screen.queryByTestId('top-bar-nav-collapse')).toBeNull();
  });
});
