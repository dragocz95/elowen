import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('next/navigation', () => ({ usePathname: () => '/tasks', useSearchParams: () => new URLSearchParams() }));
import { NavItem } from '../../../components/shell/NavItem';
import { ListChecks } from 'lucide-react';

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
    expect(screen.queryByText('Tasks')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('title', 'Tasks');
  });
});
