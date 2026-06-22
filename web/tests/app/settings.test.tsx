import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

let putBody: unknown = null;
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [], autopilot: { model: 'mimo-v2.5', apiUrl: 'https://relay.example/v1', apiKeySet: false, notes: '' }, providers: { 'claude-code': { bin: 'claude', args: '' }, opencode: { bin: 'opencode', args: '' }, codex: { bin: 'codex', args: '' } }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } })),
  http.put('*/api/config', async ({ request }) => { putBody = await request.json(); return HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], autopilot: { model: 'mimo-v2.5', apiUrl: 'https://relay.example/v1', apiKeySet: false, notes: '' }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } }); }),
  http.get('*/api/integrations/hermes/status', () => HttpResponse.json({ home: '/home/orca/.hermes', exists: true, pluginsDir: true, pluginInstalled: true, enabled: false })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('SettingsPage', () => {
  it('auto-saves a changed model allowlist on toggle (no manual save button)', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    // Models auto-persist: a toggle PUTs immediately, no separate "Save models" button.
    expect(screen.queryByRole('button', { name: 'Save models' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Claude Sonnet 4.5')); // uncheck sonnet → auto-saves
    await waitFor(() => expect((putBody as { allowedExecs: string[] }).allowedExecs).not.toContain('sonnet'));
  });

  it('auto-save sends customModels in the PUT body', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    fireEvent.click(screen.getByLabelText('Claude Sonnet 4.5')); // any change triggers the PUT
    await waitFor(() => expect((putBody as { customModels: unknown }).customModels).toBeDefined());
    expect(Array.isArray((putBody as { customModels: unknown[] }).customModels)).toBe(true);
  });

  it('edits a model description and persists it under modelNotes', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    // Each model card carries an "Add description" affordance; the first preset is GLM 5.2.
    fireEvent.click(screen.getAllByRole('button', { name: 'Add description' })[0]);
    fireEvent.change(screen.getByLabelText('Model description'), { target: { value: 'Strong at refactoring' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect((putBody as { modelNotes: Record<string, string> }).modelNotes).toMatchObject({ 'ollama-cloud/glm-5.2': 'Strong at refactoring' }));
  });

  it('renders the Add model affordance', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());
    expect(screen.getByRole('button', { name: 'Add model' })).toBeTruthy();
  });

  it('add-model modal opens on click and sends customModels with the new entry on save', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    // Modal: fill label, pick the "Other" provider, type a raw exec string.
    fireEvent.change(screen.getByPlaceholderText('My Model'), { target: { value: 'My Custom Model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    fireEvent.change(screen.getByPlaceholderText('provider/model-name'), { target: { value: 'my/custom' } });
    putBody = null;
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    // The new model card should now be in the DOM (Toggle is labelled by the model label).
    await waitFor(() => expect(screen.getByLabelText('My Custom Model')).toBeTruthy());

    // Adding the model auto-persists — no separate "Save models" click needed.
    await waitFor(() => {
      const body = putBody as { customModels: { label: string; exec: string }[] };
      expect(body.customModels).toContainEqual({ label: 'My Custom Model', exec: 'my/custom' });
    });
  });

  it('switches categories via the top pills', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());

    // Models category is active by default; Autopilot save button is hidden
    expect(screen.queryByRole('button', { name: 'Save autopilot' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Autopilot' }));
    expect(screen.getByRole('button', { name: 'Save autopilot' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save models' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
    expect(screen.getByRole('button', { name: 'Save defaults' })).toBeTruthy();
  });

  it('defaults to Relay mode and saves relay fields (execs cleared)', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Autopilot' }));
    expect(screen.getByText('How autopilot reasons')).toBeTruthy();
    expect(screen.getByText('Planner model')).toBeTruthy(); // same role labels in both modes

    fireEvent.click(screen.getByRole('button', { name: 'Save autopilot' }));
    await waitFor(() => {
      const ap = (putBody as { autopilot: { pilotExec: string; overseerExec: string } }).autopilot;
      expect(ap.pilotExec).toBe(''); // relay mode clears the agent execs
      expect(ap.overseerExec).toBe('');
    });
  });

  it('switching to CLI Tools saves agent execs (same role labels in both modes)', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Autopilot' }));
    fireEvent.click(screen.getByText('CLI Tools')); // mode toggle
    expect(screen.getByText('Planner model')).toBeTruthy(); // unified label, not a separate "Pilot backend"

    fireEvent.click(screen.getByRole('button', { name: 'Save autopilot' }));
    await waitFor(() => {
      const ap = (putBody as { autopilot: { pilotExec: string; overseerExec: string; reviewOnDone: boolean } }).autopilot;
      expect(ap.pilotExec).not.toBe(''); // seeded with a default model on switch
      expect(ap.overseerExec).not.toBe('');
      expect(ap.reviewOnDone).toBe(false);
    });
  });

  it('shows the Hermes panel with status badges and no header save button', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('Claude Sonnet 4.5')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Hermes' }));
    // Install button present; header Save button hidden for this category
    expect(screen.getByRole('button', { name: 'Install plugin' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save models' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Hermes' })).toBeTruthy();
    // Status badges reflect the mocked status (installed, disabled)
    await waitFor(() => expect(screen.getByText('installed')).toBeTruthy());
    expect(screen.getByText('disabled')).toBeTruthy();
  });

  it('opens the ConfirmDialog when deleting a custom model', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'my/custom'], customModels: [{ label: 'My Custom Model', exec: 'my/custom' }], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false, notes: '' }, defaults: { exec: 'sonnet', autonomy: 'L1', maxSessions: 1 }, security: { tokenTtlDays: 30 } })));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByLabelText('My Custom Model')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Delete my/custom' }));
    expect(await screen.findByText(/Remove My Custom Model/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByLabelText('My Custom Model')).toBeNull());
  });
});

const config = { allowedExecs: ['sonnet'], customModels: [], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false, notes: 'mind the guardrails' }, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 2 }, security: { tokenTtlDays: 30 } };

describe('Settings depth', () => {
  it('renders model toggles and a defaults segmented control', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json(config)));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);

    // Models category is active by default
    await waitFor(() => expect(screen.getAllByRole('switch').length).toBeGreaterThan(0)); // model toggle cards

    fireEvent.click(screen.getByRole('button', { name: 'Autopilot' }));
    expect(screen.getByDisplayValue('mind the guardrails')).toBeTruthy();                 // notes textarea

    fireEvent.click(screen.getByRole('button', { name: 'Defaults' }));
    expect(screen.getAllByRole('radiogroup').length).toBeGreaterThan(0);                  // defaults segmented (autonomy/exec)
  });
});
