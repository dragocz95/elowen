import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { LoginForm } from '../../../components/auth/LoginForm';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { getToken } from '../../../lib/token';

const server = setupServer();
beforeAll(() => server.listen()); afterEach(() => { server.resetHandlers(); localStorage.clear(); }); afterAll(() => server.close());

describe('LoginForm', () => {
  it('stores the token on a successful login', async () => {
    server.use(http.post('*/auth/login', () => HttpResponse.json({ token: 'tok', user: { id: 1, username: 'alice', created_at: 'now' } })));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><LoginForm onAuthed={() => {}} /></ToastProvider></Wrapper>);
    fireEvent.change(screen.getByPlaceholderText(/username/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText(/password/i), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(getToken()).toBe('tok');
  });
});
