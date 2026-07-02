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
  it('shows the user identity and their allowed models, and saves a chosen default', async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.patch('*/api/auth/me', async ({ request }) => { patched = await request.json() as Record<string, unknown>; return HttpResponse.json(meUser({ default_exec: 'sonnet' })); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></Wrapper>);

    expect(await screen.findByText('@bob')).toBeTruthy();
    // Restricted to 'sonnet' (admin allow-list) → only that model is pickable (a radio chip).
    const chip = screen.getByRole('radio', { name: /Claude Sonnet/ });
    fireEvent.click(chip); // auto-persists shortly after — no Save button

    await waitFor(() => expect(patched?.default_exec).toBe('sonnet'));
  });

  it('switches to the Prompts pill and renders the prompt editor', async () => {
    localStorage.clear(); // start on the default (profile) section
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.get('*/api/auth/me/prompts', () => HttpResponse.json([
        { name: 'worker', group: 'workers', vars: ['taskId'], jsonContract: false, default: 'DEFAULT worker', override: null },
      ])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('radio', { name: 'Prompts' }));
    // The redesigned section lists compact rows; the editor itself opens in a modal.
    expect(await screen.findByText('worker')).toBeTruthy();
    expect(screen.getByText('DEFAULT worker')).toBeTruthy();
  });
});
