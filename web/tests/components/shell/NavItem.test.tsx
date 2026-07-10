import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
vi.mock('next/navigation', () => ({ usePathname: () => '/tasks', useSearchParams: () => new URLSearchParams() }));
import { NavItem } from '../../../components/shell/NavItem';
import { Kanban, ListChecks } from 'lucide-react';

const entry = { href: '/tasks', label: 'Tasks', icon: ListChecks };

describe('NavItem', () => {
  it('shows label + Elowen brand-red active line when expanded and active', () => {
    render(<NavItem entry={entry} active collapsed={false} />);
    const link = screen.getByRole('link', { name: /Tasks/ });
    expect(link.className).toContain('border-accent'); // Elowen red — the single accent across the UI
    expect(screen.getByText('Tasks')).toBeInTheDocument();
  });
  it('hides the label and sets title when collapsed', () => {
    render(<NavItem entry={entry} active={false} collapsed />);
    const link = screen.getByRole('link');
    expect(within(link).queryByText('Tasks')).not.toBeInTheDocument();
    expect(link).toHaveAttribute('title', 'Tasks');
    expect(screen.getByLabelText('Tasks')).toBeInTheDocument();
  });

  it('marks a world parent as the current location while its exact child remains the page', () => {
    render(<NavItem entry={{
      href: '/tasks',
      label: 'Work',
      icon: ListChecks,
      subItems: [
        { id: 'tasks', href: '/tasks', label: 'Tasks', icon: ListChecks },
        { id: 'kanban', href: '/kanban', label: 'Kanban', icon: Kanban },
      ],
    }} active pathname="/tasks" collapsed={false} />);

    expect(screen.getByRole('link', { name: 'Work' })).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('link', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
  });
});
