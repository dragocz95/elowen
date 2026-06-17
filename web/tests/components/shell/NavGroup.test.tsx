import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash' }));
import { NavGroup } from '../../../components/shell/NavGroup';
import { LayoutDashboard } from 'lucide-react';

const group = { label: 'Operate', items: [{ href: '/dash', label: 'Dash', icon: LayoutDashboard }] };

describe('NavGroup', () => {
  it('renders the group label + items when expanded', () => {
    render(<NavGroup group={group} pathname="/dash" collapsed={false} />);
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dash/ })).toBeInTheDocument();
  });
  it('hides the group label when collapsed', () => {
    render(<NavGroup group={group} pathname="/dash" collapsed />);
    expect(screen.queryByText('Operate')).not.toBeInTheDocument();
  });
});
