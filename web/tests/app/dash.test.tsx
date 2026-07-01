import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import DashPage from '../../app/dash/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const config = {
  models: [], customModels: [], hiddenPresets: [], modelNotes: {},
  autopilot: { model: '', overseerModel: '', apiUrl: '', apiKeySet: false, notes: '', prompt: '', pilotExec: '', overseerExec: '', reviewOnDone: false },
  providers: {}, defaults: { exec: 'claude:sonnet', autonomy: 'L2', maxSessions: 2 }, security: { tokenTtlDays: 30 },
};

const server = setupServer(
  http.get('*/api/tasks', () => HttpResponse.json([{ id: 'orca-1', title: 'Build', status: 'open' }])),
  http.get('*/api/sessions', () => HttpResponse.json([{ name: 'orca-SwiftLake', role: 'agent', agent: 'SwiftLake' }])),
  http.get('*/api/missions', () => HttpResponse.json([])),
  http.get('*/api/sessions/:name/pane', () => HttpResponse.json({ pane: '' })),
  http.get('*/api/config', () => HttpResponse.json(config)),
  http.get('*/api/projects', () => HttpResponse.json([])),
  http.get('*/api/usage/by-model', () => HttpResponse.json([])),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('DashPage', () => {
  it('renders the live agent lane and an empty autopilot section', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DashPage /></ToastProvider></Wrapper>);
    // The live agent shows up in its lane, with the friendly name (no orca- prefix)…
    await waitFor(() => expect(screen.getByText('SwiftLake')).toBeInTheDocument());
    // …and the autopilot section renders its empty state.
    expect(screen.getAllByText(/no active missions/i).length).toBeGreaterThan(0);
  });
});
