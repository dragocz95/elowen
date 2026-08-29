import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../../../components/ui/Input';

describe('Input', () => {
  it('lets a caller override one side of the physical base padding', () => {
    render(<Input type="search" aria-label="Search models" className="pl-9" />);

    const input = screen.getByRole('searchbox', { name: 'Search models' });
    expect(input).toHaveClass('pl-9', 'pr-3');
    expect(input).not.toHaveClass('pl-3', 'px-3');
  });
});
