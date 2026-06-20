import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TaskModal } from '../../../modules/tasks/TaskModal';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const config = { allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: { model: 'm', overseerModel: '', apiUrl: 'u', apiKeySet: true, notes: '', prompt: '', pilotExec: '', overseerExec: '', reviewOnDone: false }, providers: {}, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 } };

let lastJob = 'pj-1';
const server = setupServer(
  http.get('*/config', () => HttpResponse.json(config)),
  http.get('*/tasks', () => HttpResponse.json([])),
  // Autopilot planning now returns 202 with a job id (async).
  http.post('*/tasks/plan', () => HttpResponse.json({ jobId: lastJob, epicId: 'orca-ep' }, { status: 202 })),
  // The job resolves to done with its phases.
  http.get('*/plan/:jobId', ({ params }) => HttpResponse.json({ id: params.jobId, epicId: 'orca-ep', goal: 'g', status: 'done', phases: [{ title: 'Phase A', type: 'task' }, { title: 'Phase B', type: 'feature' }] })),
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
});
