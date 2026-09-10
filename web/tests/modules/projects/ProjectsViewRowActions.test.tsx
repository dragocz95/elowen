import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { ProjectsView } from '../../../modules/projects/ProjectsView';

/** Two managed projects, so one row can be running while the other is doing something. */
const projects = [
  { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' },
  { id: 5, slug: 'reports', path: '', notes: '', icon: '', executionKind: 'managed' },
];

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json(projects)),
  http.get('*/api/projects/summary', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([{
    name: 'sandbox', url: '/plugins/sandbox/web/hash.js', apiVersion: 4,
    nav: [], account: [], project: [], settings: [], strings: {}, projectRows: true,
  }])),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** A stand-in for the sandbox bundle: it reports one running and one starting environment, and offers
 *  the four lifecycle actions with exactly the enablement each state allows. */
const chosen: string[] = [];
const contribution = {
  requiresApiVersion: 4,
  projectRows: () => ({
    status: {
      3: { label: 'Running', icon: 'Play', tone: 'success' },
      5: { label: 'Starting', icon: 'Loader2', tone: 'accent', busy: true },
    },
    actions: {
      3: [
        { id: 'start', label: 'Start environment', icon: 'Play', disabled: true, onSelect: () => chosen.push('start:3') },
        { id: 'stop', label: 'Stop environment', icon: 'Square', onSelect: () => chosen.push('stop:3') },
        { id: 'restart', label: 'Restart environment', icon: 'RotateCcw', onSelect: () => chosen.push('restart:3') },
        { id: 'snapshot', label: 'Create snapshot', icon: 'Camera', onSelect: () => chosen.push('snapshot:3') },
      ],
      5: [
        { id: 'start', label: 'Start environment', icon: 'Play', disabled: true, onSelect: () => chosen.push('start:5') },
        { id: 'stop', label: 'Stop environment', icon: 'Square', disabled: true, onSelect: () => chosen.push('stop:5') },
      ],
    },
    overlay: <div>environment progress</div>,
  }),
};

function mount() {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
}

describe('Project register rows: environment state and lifecycle actions', () => {
  beforeEach(() => {
    chosen.length = 0;
    loadPluginUi.mockReset();
    loadPluginUi.mockResolvedValue(contribution);
  });

  // The register used to say only "Managed environment" — the same six words whether the container was
  // running, cold or broken. The state is at the row's far end now, as a glyph with the state as its
  // accessible name.
  it('shows each managed row its own environment state, tone included', async () => {
    mount();
    const running = await screen.findAllByRole('img', { name: 'Running' });
    expect(running).toHaveLength(1);
    expect(running[0]!.closest('[data-project-row-status]')).toHaveAttribute('data-project-row-status', 'success');
    // An operation in flight is a spinner rather than a glyph, and still says what it is.
    const starting = await screen.findAllByRole('status', { name: 'Starting' });
    expect(starting[0]!.closest('[data-project-row-status]')).toHaveAttribute('data-project-row-status', 'busy');
    // One status per row, directly left of the row actions and on the same icon size the action menu's
    // kebab draws, so the two read as one control band.
    const menuCell = screen.getByRole('button', { name: 'analysis: Actions' }).closest('[role="cell"]') as HTMLElement;
    expect(menuCell.previousElementSibling).toBe(running[0]!.closest('[role="cell"]'));
    expect(running[0]).toHaveAttribute('width', '16');
    expect(menuCell.querySelector('svg')).toHaveAttribute('width', '16');
    // A row nobody contributed a state for carries none rather than an unknown-state glyph.
    expect(screen.queryByRole('img', { name: 'Stopped' })).toBeNull();
  });

  it('offers the lifecycle actions in the row menu, enabled by the state the plugin reported', async () => {
    mount();
    await screen.findAllByRole('img', { name: 'Running' });

    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Edit project', 'Start environment', 'Stop environment', 'Restart environment', 'Create snapshot', 'Copy path', 'Remove project',
    ]);
    // Running: stopping is offered, starting is present and unselectable rather than absent, so the menu
    // keeps its shape as the state moves under the pointer.
    expect(screen.getByRole('menuitem', { name: 'Start environment' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Stop environment' })).not.toHaveAttribute('data-disabled');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop environment' }));
    await waitFor(() => expect(chosen).toEqual(['stop:3']));
  });

  it('offers the same lifecycle actions on right-click, and the plugin renders its own dialogs once', async () => {
    mount();
    await screen.findAllByRole('img', { name: 'Running' });
    const row = screen.getByRole('button', { name: 'Open project analysis' }).closest('[role="row"]');
    if (!row) throw new Error('project row not rendered');

    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    const menuActions = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));

    fireEvent.contextMenu(row);
    const contextActions = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(contextActions).toEqual(menuActions);
    expect(screen.getByRole('menuitem', { name: 'Start environment' })).toHaveAttribute('data-disabled');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart environment' }));
    await waitFor(() => expect(chosen).toEqual(['restart:3']));

    expect(screen.getAllByText('environment progress')).toHaveLength(1);
  });

  // The busy row's menu is the same list; only what it allows differs.
  it('refuses a start and a stop on a row whose environment is already moving', async () => {
    mount();
    await screen.findAllByRole('status', { name: 'Starting' });
    fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
    await screen.findAllByRole('menuitem');

    expect(screen.getByRole('menuitem', { name: 'Start environment' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Stop environment' })).toHaveAttribute('data-disabled');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start environment' }));
    expect(chosen).toEqual([]);
  });
});
