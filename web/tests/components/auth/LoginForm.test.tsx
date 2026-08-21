import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { LoginForm } from '../../../components/auth/LoginForm';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  navigation.replace.mockReset();
  window.history.replaceState({}, '', '/');
});
afterAll(() => server.close());

function renderLoginForm(onAuthed = () => {}) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><LoginForm onAuthed={onAuthed} /></ToastProvider></Wrapper>);
}

describe('LoginForm', () => {
  it('uses the shared control surface without app-workspace identity chrome', () => {
    server.use(http.get('*/api/auth/sso/providers', () => HttpResponse.json([])));
    const { container } = renderLoginForm();
    expect(container.querySelectorAll('[data-control-surface]')).toHaveLength(1);
    expect(container.querySelector('.spatial-mascot')).toBeNull();
  });

  it('calls onAuthed on a successful login (the proxy set the cookie; nothing stored client-side)', async () => {
    server.use(
      http.get('*/api/auth/sso/providers', () => HttpResponse.json([])),
      http.post('*/api/auth/login', () => HttpResponse.json({ ok: true })),
    );
    const onAuthed = vi.fn();
    renderLoginForm(onAuthed);
    fireEvent.change(screen.getByPlaceholderText(/username/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(onAuthed).toHaveBeenCalledOnce());
  });

  it('does not render the Microsoft button when no SSO provider is available', async () => {
    server.use(http.get('*/api/auth/sso/providers', () => HttpResponse.json([])));
    renderLoginForm();
    await waitFor(() => expect(screen.queryByRole('link', { name: /Microsoft/i })).toBeNull());
  });

  it('renders a full-navigation Microsoft link when an SSO provider is available', async () => {
    window.history.replaceState({}, '', '/dash?tab=one');
    server.use(http.get('*/api/auth/sso/providers', () => HttpResponse.json([{ id: 'msteams', label: 'Microsoft' }])));
    renderLoginForm();
    const link = await screen.findByRole('link', { name: /Microsoft/i });
    expect(link).toHaveAttribute('href', '/api/auth/sso/microsoft/start?next=%2Fdash%3Ftab%3Done');
  });
});
