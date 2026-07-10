import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeToggle } from '../../../components/ui/ThemeToggle';

describe('ThemeToggle', () => {
  it('renders no theme action in the OLED-only interface', () => {
    const { container } = render(<ThemeToggle />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
