import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createWrapper } from './test-utils';
import { en } from '../lib/i18n/dictionaries/en';
import Home from '../app/page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

describe('scaffold', () => {
  it('renders the loading state', () => {
    render(<Home />, { wrapper: createWrapper().wrapper });
    expect(screen.getByText(en.common.loading)).toBeInTheDocument();
  });
});
