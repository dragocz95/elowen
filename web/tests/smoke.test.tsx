import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Home from '../app/page';

describe('scaffold', () => {
  it('renders the home placeholder', () => {
    render(<Home />);
    expect(screen.getByText('orca')).toBeInTheDocument();
  });
});
