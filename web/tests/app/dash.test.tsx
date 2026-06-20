import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import DashPage from '../../app/dash/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const server = setupServer(
  http.get('http://localhost:4400/tasks', () => HttpResponse.json([{ id: 'orca-1', title: 'Build', status: 'open' }])),
  http.get('http://localhost:4400/sessions', () => HttpResponse.json([{ name: 'orca-SwiftLake', role: 'agent', agent: 'SwiftLake' }])),
  http.get('http://localhost:4400/missions', () => HttpResponse.json([])),
  http.get('http://localhost:4400/sessions/:name/pane', () => HttpResponse.json({ pane: '' })),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('DashPage', () => {
  it('renders live tasks and sessions, empty missions', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DashPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Build')).toBeInTheDocument());
    expect(screen.getByText('orca-SwiftLake')).toBeInTheDocument();
    expect(screen.getAllByText(/no active missions/i).length).toBeGreaterThan(0);
  });
});
