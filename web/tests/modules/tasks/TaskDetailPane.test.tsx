import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TaskDetailPane } from '../../../modules/tasks/TaskDetailPane';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer(
  http.get('*/tasks/deps', () => HttpResponse.json([])),
  http.get('*/activity', () => HttpResponse.json([])),
  http.get('*/sessions/orca-nova/pane', () => HttpResponse.json({ pane: 'npm test\nall good' })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('TaskDetailPane', () => {
  it('renders the result summary for a closed task', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'tc', title: 'Closed one', status: 'closed', outcome: 'ok', result_summary: 'shipped it' }]);
    render(<Wrapper><ToastProvider><TaskDetailPane taskId="tc" /></ToastProvider></Wrapper>);
    expect(await screen.findByText('shipped it')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
  });

  it('renders the live tail for a running task', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'tr', title: 'Running one', status: 'in_progress', labels: ['agent:nova'] }]);
    client.setQueryData(['sessions'], ['orca-nova']);
    render(<Wrapper><ToastProvider><TaskDetailPane taskId="tr" /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Live output')).toBeTruthy();
    expect(await screen.findByText(/all good/)).toBeTruthy();
  });
});
