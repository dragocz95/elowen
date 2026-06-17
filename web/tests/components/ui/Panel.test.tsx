import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Panel } from '../../../components/ui/Panel';
import { PageHeader } from '../../../components/ui/PageHeader';

describe('Panel + PageHeader', () => {
  it('Panel renders children inside a bordered surface', () => {
    render(<Panel>inside</Panel>);
    const el = screen.getByText('inside');
    expect(el).toBeInTheDocument();
    expect(el.className + (el.parentElement?.className ?? '')).toContain('border');
  });
  it('PageHeader shows the title and count', () => {
    render(<PageHeader title="Tasks" count={7} />);
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('7')).toHaveClass('font-mono');
  });
});
