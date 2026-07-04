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
  http.get('*/api/usage/by-day', () => HttpResponse.json([])),
  http.get('*/api/plugins/cronjob/jobs', () => HttpResponse.json([])),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('DashPage', () => {
  it('renders the bento dashboard with the live agent attributed in the hero', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DashPage /></ToastProvider></Wrapper>);
    // The hero attributes the current work to the live agent (friendly name, no orca- prefix)…
    await waitFor(() => expect(screen.getByText('Agent SwiftLake')).toBeInTheDocument());
    // …and the bento tiles render (the "right now" hero label).
    expect(screen.getAllByText('Right now').length).toBeGreaterThan(0);
  });
});
