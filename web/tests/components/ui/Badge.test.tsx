import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../../../components/ui/Badge';

describe('Badge', () => {
  it('Badge renders mono label', () => {
    render(<Badge>working</Badge>);
    expect(screen.getByText('working')).toHaveClass('font-mono');
  });
});
