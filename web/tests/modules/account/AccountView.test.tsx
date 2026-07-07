import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { AccountView } from '../../../modules/account/AccountView';
import { ToastProvider } from '../../../components/ui/Toast';
import { UiScaleProvider } from '../../../lib/useUiScale';
import { createWrapper } from '../../test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const meUser = (over: Record<string, unknown> = {}) => ({ id: 2, username: 'bob', name: '', email: '', avatar: '', default_exec: '', is_admin: false, allowed_execs: ['sonnet'], created_at: '2026-01-01', ...over });

describe('AccountView', () => {
  it('shows the user identity, and saves a default picked on the Orca AI tab', async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.patch('*/api/auth/me', async ({ request }) => { patched = await request.json() as Record<string, unknown>; return HttpResponse.json(meUser({ default_exec: 'sonnet' })); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></Wrapper>);

    expect(await screen.findByText('@bob')).toBeTruthy();
    // The default-model rail lives on the Orca AI tab (with the other per-user AI settings).
    fireEvent.click(screen.getByRole('radio', { name: 'Orca AI' }));
    // Restricted to 'sonnet' (admin allow-list) → only that model is pickable (a radio chip).
    const chip = screen.getByRole('radio', { name: /Claude Sonnet/ });
    fireEvent.click(chip); // auto-persists shortly after — no Save button

    await waitFor(() => expect(patched?.default_exec).toBe('sonnet'));
  });

  it('falls back to the profile section when a removed section id is persisted', async () => {
    localStorage.setItem('orca.account.section', 'prompts'); // the Prompts tab no longer exists
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></Wrapper>);

    // The stale value fails the allowed-list guard, so the default (profile) section renders.
    expect(await screen.findByText('@bob')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Prompts' })).toBeNull();
  });
});
