import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createWrapper } from '../test-utils';
import { onUnhandledRequest } from '../msw';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { usePluginProjectRows } from '../../lib/pluginProjectRows';
import type { Project } from '../../lib/types';

const projects = [
  { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' },
  { id: 4, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '' },
] as unknown as Project[];

const entry = (over: Record<string, unknown> = {}) => ({
  name: 'sandbox', url: '/plugins/sandbox/web/hash.js', apiVersion: 4,
  nav: [], account: [], project: [], settings: [], strings: {}, projectRows: true, ...over,
});

const server = setupServer(http.get('*/api/plugins/ui', () => HttpResponse.json([entry()])));
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** The register's side of the seam, with none of the register around it. */
function Harness() {
  const rows = usePluginProjectRows(projects);
  return (
    <div>
      {projects.map((project) => (
        <div key={project.id} data-testid={`row-${project.id}`}>
          <span data-testid={`status-${project.id}`}>{rows.statusFor(project.id)?.label ?? '—'}</span>
          {rows.actionsFor(project.id).map((action) => (
            <button key={`${action.plugin}:${action.id}`} type="button" disabled={action.disabled} onClick={action.onSelect}>
              {action.label}
            </button>
          ))}
        </div>
      ))}
      {rows.hosts}
    </div>
  );
}

describe('plugin Project-row contributions', () => {
  beforeEach(() => loadPluginUi.mockReset());

  it('asks the contributing bundle about the rows on screen and shows what it answered', async () => {
    const seen: number[][] = [];
    const started: number[] = [];
    loadPluginUi.mockResolvedValue({
      requiresApiVersion: 4,
      projectRows: ({ projects: rows }: { projects: Project[] }) => {
        seen.push(rows.map((row) => row.id));
        return {
          status: { 3: { label: 'Running', icon: 'CircleDot', tone: 'success' } },
          actions: { 3: [
            { id: 'start', label: 'Start environment', icon: 'Play', disabled: true, onSelect: () => started.push(3) },
            { id: 'stop', label: 'Stop environment', icon: 'Square', onSelect: () => started.push(-3) },
          ] },
          overlay: <div>plugin overlay</div>,
        };
      },
    });
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><Harness /></Wrapper>);

    expect(await screen.findByText('Running')).toBeInTheDocument();
    // The hook is called with the rows the register is showing, both of them, and answers per project:
    // the host project it said nothing about carries no status and no actions.
    expect(seen.at(-1)).toEqual([3, 4]);
    expect(screen.getByTestId('status-4')).toHaveTextContent('—');
    expect(screen.getByTestId('row-4').querySelectorAll('button')).toHaveLength(0);
    // The plugin's own dialogs render with it, once, outside the rows.
    expect(screen.getByText('plugin overlay')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Start environment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop environment' }));
    expect(started).toEqual([-3]);
  });

  it('loads no bundle for a plugin that contributes nothing to a row, or asks for a newer host', async () => {
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([
      entry({ name: 'quiet', projectRows: undefined }),
      entry({ name: 'newer', apiVersion: 9999 }),
    ])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><Harness /></Wrapper>);

    await waitFor(() => expect(screen.getByTestId('status-3')).toHaveTextContent('—'));
    expect(loadPluginUi).not.toHaveBeenCalled();
  });

  it('shows nothing rather than an error when a contributing bundle fails to load', async () => {
    loadPluginUi.mockResolvedValue(null);
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><Harness /></Wrapper>);

    await waitFor(() => expect(loadPluginUi).toHaveBeenCalledWith('sandbox', '/plugins/sandbox/web/hash.js', undefined));
    expect(screen.getByTestId('status-3')).toHaveTextContent('—');
  });
});
