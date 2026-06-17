import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { UsersPanel } from '../../../modules/users/UsersPanel';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/users', () => HttpResponse.json([
    { id: 1, username: 'alice', created_at: '2026-01-01' },
    { id: 2, username: 'bob', created_at: '2026-01-02' },
  ])),
);
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('UsersPanel', () => {
  it('lists users from the API', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><UsersPanel /></ToastProvider></Wrapper>);
    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
  });
});
