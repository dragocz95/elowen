import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
vi.mock('next/navigation', () => ({ usePathname: () => '/dash' }));
import { Sidebar } from '../../../components/shell/Sidebar';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen()); afterAll(() => server.close());
beforeEach(() => localStorage.clear());

describe('Sidebar (registry-driven)', () => {
  it('renders wordmark + groups + active item from the registry', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><Sidebar /></Wrapper>);
    expect(screen.getByAltText('Orca')).toBeInTheDocument();
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByText('Config')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dash/ }).className).toContain('border-accent');
  });
});
