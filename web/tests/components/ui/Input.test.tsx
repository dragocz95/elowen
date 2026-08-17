import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../../../components/ui/Input';

describe('Input', () => {
  it('uses physical base padding so an icon offset can override it across engines', () => {
    render(<Input type="search" aria-label="Search models" className="pl-9" />);

    const input = screen.getByRole('searchbox', { name: 'Search models' });
    expect(input).toHaveClass('pl-3', 'pr-3', 'pl-9');
    expect(input).not.toHaveClass('px-3');
  });
});
