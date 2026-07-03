import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import MemoryPage from '../../app/memory/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const MEMORY = {
  id: 1, user_id: 1, body: 'Filip prefers pnpm over npm', kind: 'preference', importance: 0.8,
  confidence: 0.9, source: 'user', status: 'active', created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00', last_used_at: null, use_count: 3,
};

const server = setupServer(
  http.get('*/api/memory', () => HttpResponse.json([MEMORY])),
  http.get('*/api/memory/1', () => HttpResponse.json(MEMORY)),
  http.get('*/api/memory/events', () => HttpResponse.json([])),
  http.get('*/api/memory/1/events', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true, allowed_execs: [], name: 'Admin', email: '', avatar: '', default_exec: '', advisor_exec: '', advisor_autostart: false, created_at: '' } })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());

describe('MemoryPage', () => {
  it('lists memories and opens a detail on select', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MemoryPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getAllByText('Filip prefers pnpm over npm').length).toBeGreaterThan(0));
    // Selecting the row opens the detail pane, which shows the memory id (#1).
    fireEvent.click(screen.getAllByText('Filip prefers pnpm over npm')[0]);
    await waitFor(() => expect(screen.getByText('#1')).toBeInTheDocument());
  });
});
