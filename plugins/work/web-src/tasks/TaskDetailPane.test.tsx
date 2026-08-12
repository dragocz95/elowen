import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../../../web/tests/msw';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { TaskDetailPane } = await import('./TaskDetailPane');
import { ToastProvider } from '../../../../web/components/ui/Toast';
import { createWrapper } from '../../../../web/tests/test-utils';

const server = setupServer(
  http.get('*/api/tasks/deps', () => HttpResponse.json([])),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/sessions/elowen-nova/pane', () => HttpResponse.json({ pane: 'npm test\nall good' })),
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

  it('renders the mission summary under a distinct label for a closed epic', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'ep', title: 'Big mission', type: 'epic', status: 'closed', outcome: 'ok', result_summary: 'three phases shipped' }]);
    render(<Wrapper><ToastProvider><TaskDetailPane taskId="ep" /></ToastProvider></Wrapper>);
    expect(await screen.findByText('three phases shipped')).toBeTruthy();
    expect(screen.getByText('Mission summary')).toBeTruthy(); // not the generic "Result" — an epic carries the autopilot mission summary
  });

  it('renders the live tail for a running task', async () => {
    const { wrapper: Wrapper, client } = createWrapper();
    client.setQueryData(['tasks'], [{ id: 'tr', title: 'Running one', status: 'in_progress', labels: ['agent:nova'] }]);
    client.setQueryData(['sessions'], [{ name: 'elowen-nova', role: 'agent', agent: 'nova' }]);
    render(<Wrapper><ToastProvider><TaskDetailPane taskId="tr" /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Live output')).toBeTruthy();
    expect(await screen.findByText(/all good/)).toBeTruthy();
  });
});
