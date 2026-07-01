import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import DashPage from '../../app/dash/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const server = setupServer(
  http.get('*/api/tasks', () => HttpResponse.json([{ id: 'orca-1', title: 'Build', status: 'open' }])),
  http.get('*/api/tasks/deps', () => HttpResponse.json([])),
  http.get('*/api/sessions', () => HttpResponse.json([{ name: 'orca-SwiftLake', role: 'agent', agent: 'SwiftLake' }])),
  http.get('*/api/sessions/:name/pane', () => HttpResponse.json({ pane: '' })),
  http.get('*/api/missions', () => HttpResponse.json([])),
  http.get('*/api/asks/pending', () => HttpResponse.json([])),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/usage/by-model', () => HttpResponse.json([])),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('DashPage', () => {
  it('renders the live agent in the constellation and an empty live-missions section', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DashPage /></ToastProvider></Wrapper>);
    // The live agent appears as a constellation node with its friendly name (no orca- prefix)…
    await waitFor(() => expect(screen.getByText('SwiftLake')).toBeInTheDocument());
    // …and the live-missions section renders its empty state.
    expect(screen.getAllByText(/no active missions/i).length).toBeGreaterThan(0);
  });
});
