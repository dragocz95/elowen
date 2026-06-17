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
  it('PageHeader shows uppercased title and mono count', () => {
    render(<PageHeader title="Tasks" count={7} />);
    expect(screen.getByText('Tasks')).toHaveClass('uppercase');
    expect(screen.getByText('7')).toHaveClass('font-mono');
  });
});
