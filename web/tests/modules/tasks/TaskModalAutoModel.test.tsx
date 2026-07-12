import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { TaskModal } from '../../../modules/tasks/TaskModal';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

interface PlanBody { autoModel?: boolean; exec?: string; pilotExec?: string; overseerExec?: string }
let planBody: PlanBody | null = null;
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], modelNotes: { sonnet: 'coder' }, autopilot: { model: 'm', overseerModel: '', apiUrl: 'u', apiKeySet: true, notes: '', prompt: '', pilotExec: '', overseerExec: '', reviewOnDone: false }, providers: {}, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 }, security: { tokenTtlDays: 30 } })),
  http.get('*/api/tasks', () => HttpResponse.json([])),
  http.get('*/api/projects', () => HttpResponse.json([])),
  http.get('*/api/brain/models', () => HttpResponse.json([])),
  http.post('*/api/tasks/plan', async ({ request }) => { planBody = await request.json() as PlanBody; return HttpResponse.json({ jobId: 'pj-1', epicId: 'e1' }, { status: 202 }); }),
  http.get('*/api/plan/pj-1', () => HttpResponse.json({ id: 'pj-1', status: 'done', phases: [], epicId: 'e1', goal: '', projectId: 1 })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('TaskModal — auto model toggle', () => {
  it('submits per-mission planner and overseer choices', async () => {
    planBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} /></ToastProvider></Wrapper>);
    await waitFor(() => screen.getByText('Autopilot · Planning'));
    fireEvent.click(screen.getByText('Autopilot · Planning'));
    fireEvent.change(screen.getByPlaceholderText('Describe the goal to plan…'), { target: { value: 'build x' } });

    fireEvent.click(screen.getByRole('button', { name: 'Planner' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Claude Sonnet 4.5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    fireEvent.click(screen.getByRole('button', { name: 'Overseer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Claude Sonnet 4.5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));
    await waitFor(() => expect(planBody).not.toBeNull());
    expect(planBody).toMatchObject({ pilotExec: 'sonnet', overseerExec: 'sonnet' });
  });

  it('hides the executor picker and sends autoModel without exec', async () => {
    planBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} /></ToastProvider></Wrapper>);
    // Switch to autopilot planning mode (Segmented option).
    await waitFor(() => screen.getByText('Autopilot · Planning'));
    fireEvent.click(screen.getByText('Autopilot · Planning'));
    // Target the goal textarea by placeholder — the optional mission-name input is also a textbox.
    fireEvent.change(screen.getByPlaceholderText('Describe the goal to plan…'), { target: { value: 'build x' } });

    // Planning mode shows the executor picker (its "Executor" field label).
    expect(screen.getByText('Executor')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Autopilot picks the model' }));
    // Auto-model on → the executor picker is hidden.
    expect(screen.queryByText('Executor')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Generate plan' }));
    await waitFor(() => expect(planBody).not.toBeNull());
    expect(planBody).toMatchObject({ autoModel: true });
    expect(planBody).not.toHaveProperty('exec'); // undefined exec is dropped by JSON.stringify
  });
});
