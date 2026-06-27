import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TaskModal } from '../../../modules/tasks/TaskModal';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

// The full terminal pulls in xterm via a dynamic import; stub both so the expanded modal renders
// synchronously in jsdom (mirrors the sessions page test).
vi.mock('../../../components/terminal/StreamTerminal', () => ({ StreamTerminal: ({ name }: { name: string }) => <div data-testid="term">{name}</div> }));
vi.mock('next/dynamic', () => ({
  default: <P extends object>(loader: () => Promise<{ default?: React.ComponentType<P> } | React.ComponentType<P>>): React.ComponentType<P> => {
    let resolved: React.ComponentType<P> | null = null;
    void loader().then((mod) => {
      const m = mod as Record<string, unknown>;
      resolved = (typeof m.default === 'function' ? m.default : mod) as React.ComponentType<P>;
    });
    return function DynamicWrapper(props: P) {
      if (!resolved) return null;
      return React.createElement(resolved, props);
    };
  },
}));

const config = { allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: { model: 'm', overseerModel: '', apiUrl: 'u', apiKeySet: true, notes: '', prompt: '', pilotExec: '', overseerExec: '', reviewOnDone: false }, providers: {}, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 } };

let lastJob = 'pj-1';
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json(config)),
  http.get('*/api/tasks', () => HttpResponse.json([])),
  // Autopilot planning now returns 202 with a job id (async).
  http.post('*/api/tasks/plan', () => HttpResponse.json({ jobId: lastJob, epicId: 'orca-ep' }, { status: 202 })),
  // The job resolves to done with its phases.
  http.get('*/api/plan/:jobId', ({ params }) => HttpResponse.json({ id: params.jobId, epicId: 'orca-ep', goal: 'g', status: 'done', phases: [{ title: 'Phase A', type: 'task' }, { title: 'Phase B', type: 'feature' }] })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('async autopilot planning in TaskModal', () => {
  it('submits a goal, polls the job, and renders the resolved phases', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Autopilot · Planning')).toBeTruthy());

    fireEvent.click(screen.getByText('Autopilot · Planning'));
    fireEvent.change(screen.getByPlaceholderText('Describe the goal to plan…'), { target: { value: 'build a thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));

    // The job resolves to done → its phases render in the outcome list.
    await waitFor(() => expect(screen.getByText('Phase A')).toBeTruthy());
    expect(screen.getByText('Phase B')).toBeTruthy();
  });

  it('live-previews the planner pane while the agent-mode job is still planning', async () => {
    // Agent-mode planning stays `planning` and exposes the Pilot's tmux session; the modal should
    // render a live preview of that pane under the loader until the plan resolves.
    server.use(
      http.get('*/api/plan/:jobId', ({ params }) => HttpResponse.json({ id: params.jobId, epicId: null, goal: 'g', status: 'planning', phases: [], sessionName: 'orca-pilot-Nova' })),
      http.get('*/api/sessions/orca-pilot-Nova/pane', () => HttpResponse.json({ pane: 'reading the repo…' })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Autopilot · Planning')).toBeTruthy());

    fireEvent.click(screen.getByText('Autopilot · Planning'));
    fireEvent.change(screen.getByPlaceholderText('Describe the goal to plan…'), { target: { value: 'build a thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));

    // The Pilot's pane is streamed live under the planning loader.
    await waitFor(() => expect(screen.getByText('reading the repo…')).toBeTruthy());
    expect(screen.getByText('Planner at work')).toBeTruthy();
  });

  it('expands the planner preview into the full terminal modal on click', async () => {
    server.use(
      http.get('*/api/plan/:jobId', ({ params }) => HttpResponse.json({ id: params.jobId, epicId: null, goal: 'g', status: 'planning', phases: [], sessionName: 'orca-pilot-Nova' })),
      http.get('*/api/sessions/orca-pilot-Nova/pane', () => HttpResponse.json({ pane: 'reading the repo…' })),
      // Both useSessionInfos (modal title) and useCloseOnAgentDone (keep-open) read this list.
      http.get('*/api/sessions', () => HttpResponse.json([{ name: 'orca-pilot-Nova', role: 'pilot', agent: 'Nova' }])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('Autopilot · Planning')).toBeTruthy());

    fireEvent.click(screen.getByText('Autopilot · Planning'));
    fireEvent.change(screen.getByPlaceholderText('Describe the goal to plan…'), { target: { value: 'build a thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));

    // Click the live tail → the full session terminal opens over the modal, titled by the pilot role.
    await waitFor(() => expect(screen.getByText('reading the repo…')).toBeTruthy());
    fireEvent.click(screen.getByText('reading the repo…'));
    await waitFor(() => expect(screen.getByText('Planner')).toBeTruthy()); // the TerminalModal title (rolePilot)
  });
});
