import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../../../web/tests/msw';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { TaskModal } = await import('./TaskModal');
import { ToastProvider } from '../../../../web/components/ui/Toast';
import { createWrapper } from '../../../../web/tests/test-utils';

vi.mock('../../../../web/components/ui/ProjectIcon', () => ({
  ProjectIcon: ({ project }: { project: { id: number; icon?: string } }) => <span data-testid={`project-icon-${project.id}`} data-icon={project.icon} />,
}));

interface CreateBody { title?: string; project_id?: number }
let createBody: CreateBody | null = null;
const projects = [
  { id: 1, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: 'assets/icon.png', pr_enabled: null },
  { id: 2, slug: 'shop', path: '/srv/shop', notes: '', icon: '', pr_enabled: null },
];
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], modelNotes: {}, autopilot: { model: 'm', overseerModel: '', apiUrl: 'u', apiKeySet: true, notes: '', prompt: '', pilotExec: '', overseerExec: '', reviewOnDone: false }, providers: {}, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 }, security: { tokenTtlDays: 30 } })),
  http.get('*/api/tasks', () => HttpResponse.json([])),
  http.get('*/api/projects', () => HttpResponse.json(projects)),
  http.get('*/api/brain/models', () => HttpResponse.json([])),
  http.get('*/api/projects/1/raw', () => new HttpResponse(new Blob(['icon'], { type: 'image/png' }))),
  http.post('*/api/tasks', async ({ request }) => { createBody = await request.json() as CreateBody; return HttpResponse.json({ id: 'elowen-1', title: createBody.title, status: 'open', project_id: createBody.project_id }, { status: 201 }); }),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('TaskModal — defaultProjectId (active project filter carries into New task)', () => {
  it('renders the configured project image in the project selector', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByTestId('project-icon-1')).toHaveAttribute('data-icon', 'assets/icon.png'));
  });
  it('pre-selects the project pill matching defaultProjectId, with no click needed', async () => {
    createBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} defaultProjectId={2} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('shop').closest('button')!.className).toMatch(/border-accent/));
    fireEvent.change(screen.getByPlaceholderText('What needs doing?'), { target: { value: 'Fix bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({ project_id: 2 });
  });

  it('falls back to the first project when no defaultProjectId is given (unfiltered "all" view)', async () => {
    createBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('elowen').closest('button')!.className).toMatch(/border-accent/));
    fireEvent.change(screen.getByPlaceholderText('What needs doing?'), { target: { value: 'Fix bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({ project_id: 1 });
  });

  it('clicking a different pill still overrides the default', async () => {
    createBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TaskModal onClose={() => {}} defaultProjectId={2} /></ToastProvider></Wrapper>);
    await waitFor(() => screen.getByText('elowen'));
    fireEvent.click(screen.getByText('elowen'));
    fireEvent.change(screen.getByPlaceholderText('What needs doing?'), { target: { value: 'Fix bug' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toMatchObject({ project_id: 1 });
  });
});
