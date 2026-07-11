import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { LoginForm } from '../../../components/auth/LoginForm';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer();
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('LoginForm', () => {
  it('uses the shared control surface without app-workspace identity chrome', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><LoginForm onAuthed={() => {}} /></ToastProvider></Wrapper>);
    expect(container.querySelectorAll('[data-control-surface]')).toHaveLength(1);
    expect(container.querySelector('.spatial-mascot')).toBeNull();
  });

  it('calls onAuthed on a successful login (the proxy set the cookie; nothing stored client-side)', async () => {
    server.use(http.post('*/api/auth/login', () => HttpResponse.json({ ok: true })));
    const onAuthed = vi.fn();
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><LoginForm onAuthed={onAuthed} /></ToastProvider></Wrapper>);
    fireEvent.change(screen.getByPlaceholderText(/username/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await waitFor(() => expect(onAuthed).toHaveBeenCalledOnce());
  });
});
