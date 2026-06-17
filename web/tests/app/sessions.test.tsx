import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import SessionsPage from '../../app/sessions/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

let killed = false;
const server = setupServer(
  http.get('http://localhost:4400/sessions', () => HttpResponse.json(['orca-SwiftLake'])),
  http.delete('http://localhost:4400/sessions/orca-SwiftLake', () => { killed = true; return HttpResponse.json({ ok: true }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('SessionsPage', () => {
  it('kills a session', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SessionsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('orca-SwiftLake')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Kill' }));
    await waitFor(() => expect(killed).toBe(true));
  });
});
