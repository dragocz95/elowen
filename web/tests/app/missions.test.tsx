import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import MissionsPage from '../../app/missions/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

let engageBody: unknown = null;
const server = setupServer(
  http.get('http://localhost:4400/missions', () => HttpResponse.json([])),
  http.get('http://localhost:4400/tasks', () => HttpResponse.json([{ id: 'orca-epic', title: 'Ship it', status: 'open', type: 'epic', labels: [] }])),
  http.get('http://localhost:4400/config', () => HttpResponse.json({ defaults: { autonomy: 'L3', maxSessions: 1 } })),
  http.post('http://localhost:4400/missions', async ({ request }) => { engageBody = await request.json(); return HttpResponse.json({ id: 'm1', state: 'active' }, { status: 201 }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('MissionsPage', () => {
  it('engages a mission by picking an epic in the modal', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><MissionsPage /></ToastProvider></Wrapper>);
    fireEvent.click(screen.getByRole('button', { name: 'New mission' }));
    await waitFor(() => expect(screen.getByText('Ship it')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Ship it'));
    fireEvent.click(screen.getByRole('button', { name: 'Engage' }));
    await waitFor(() => expect(engageBody).toMatchObject({ epicId: 'orca-epic', autonomy: 'L3', maxSessions: 1 }));
  });
});
