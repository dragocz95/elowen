import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { Shell } from '../../components/shell/Shell';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

class FakeES {
  onmessage = null;
  close() {}
  constructor(public url: string) {}
}
(globalThis as any).EventSource = FakeES as any;

const server = setupServer(http.get('http://localhost:4400/health', () => HttpResponse.json({ ok: true })));
beforeAll(() => server.listen());
afterAll(() => server.close());

describe('Shell', () => {
  it('renders nav + topbar + the content slot', () => {
    render(<Shell><span>page-body</span></Shell>);
    expect(screen.getByRole('link', { name: 'Dash' })).toBeInTheDocument();
    expect(screen.getByText('page-body')).toBeInTheDocument();
  });
});
