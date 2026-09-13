import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import manifest from '../../../plugins/sandbox/elowen-plugin.json';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { onUnhandledRequest } from '../msw';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { ProjectsView } from '../../modules/projects/ProjectsView';
import { PROJECT_USAGE_QUERY_POLICY, useProjectRowContribution } from '../../../plugins/sandbox/web-src/projectRows';

ensurePluginUiRuntime();
const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

/** One managed project that is running, one that is stopped, and a host project the plugin owns nothing
 *  of — the three cases a register row can be in. */
const projects = [
  { id: 3, slug: 'analysis', path: '', notes: '', icon: '', executionKind: 'managed' },
  { id: 5, slug: 'reports', path: '', notes: '', icon: '', executionKind: 'managed' },
  { id: 7, slug: 'elowen', path: '/var/www/elowen', notes: '', icon: '' },
];
const environmentOf = (projectId: number, state: string) => ({
  projectId, generation: 2, state, desiredState: state, lastError: null,
  limits: { cpus: 1, memoryMb: 1024, pidsLimit: 512 },
});

let posted: { projectId: number; body: unknown }[] = [];
let usageRequests: number[][] = [];
const usageOf = (projectId: number, state: string) => ({
  projectId,
  environment: environmentOf(projectId, state),
  resources: state === 'running' ? {
    cpu: { state: 'ready', usedCpus: 0.5, percent: 50 },
    memory: { state: 'ready', usedBytes: 256 * 1024 * 1024, limitBytes: 1024 * 1024 * 1024 },
    disk: { state: 'ready', usedBytes: 512 * 1024 * 1024, limitBytes: null },
  } : {
    cpu: { state: 'stopped', usedCpus: null, percent: null },
    memory: { state: 'stopped', usedBytes: null, limitBytes: 1024 * 1024 * 1024 },
    disk: { state: 'ready', usedBytes: 128 * 1024 * 1024, limitBytes: null },
  },
});

const server = setupServer(
  http.get('*/api/projects', () => HttpResponse.json(projects)),
  http.get('*/api/projects/summary', () => HttpResponse.json([])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', is_admin: true } })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([{
    name: 'sandbox', url: '/plugins/sandbox/web/hash.js', apiVersion: 16,
    nav: [], account: [], project: [], settings: [], strings, projectRows: true,
  }])),
  http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
    const { projectIds } = await request.json() as { projectIds: number[] };
    usageRequests.push(projectIds);
    return HttpResponse.json({ sampledAt: '2026-01-01T00:00:00.000Z', projects: projectIds
      .map((projectId) => usageOf(projectId, projectId === 3 ? 'running' : 'stopped')) });
  }),
  // The read the project drawer performs when it opens a managed project. It is the SAME route the
  // lifecycle action posts to, which is why an invented `/api/projects/:id/environment-state` handler
  // matched nothing and quietly left the drawer's own read unstubbed.
  http.get('*/api/plugins/sandbox/api/projects/:id/environment', ({ params }) =>
    HttpResponse.json({ environment: { state: Number(params.id) === 3 ? 'running' : 'stopped' } })),
  http.get('*/api/projects/:id/git', () => HttpResponse.json({ isRepo: false, status: null, remotes: [], branches: [], commits: [] })),
  http.post('*/api/plugins/sandbox/api/projects/:id/environment', async ({ params, request }) => {
    const projectId = Number(params.id);
    const body = await request.json() as { action: { kind: string }; requestId: string };
    posted.push({ projectId, body });
    return HttpResponse.json({
      id: 'op-1', requestId: body.requestId, projectId, generation: 2, accountUserId: 1,
      action: body.action, status: 'pending', error: null,
      steps: ['image', 'storage', 'container', 'boot', 'initialize'], stepIndex: 0, stepTotal: 5, stepLabel: 'image', percent: 0,
    });
  }),
  http.get('*/api/plugins/sandbox/api/environments/operation', () => HttpResponse.json({
    id: 'op-1', requestId: 'r', projectId: 5, generation: 2, accountUserId: 1, action: { kind: 'start' },
    status: 'running', error: null, steps: ['image', 'storage', 'container', 'boot', 'initialize'],
    stepIndex: 2, stepTotal: 5, stepLabel: 'container', percent: 40, logTail: [],
  })),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());

function mount() {
  const { wrapper: Wrapper, client } = createWrapper();
  render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
  return client;
}

describe('sandbox contribution to the Project register rows', () => {
  beforeEach(() => {
    posted = [];
    usageRequests = [];
    loadPluginUi.mockReset();
    // Exactly what the built bundle registers, running against the real host runtime.
    loadPluginUi.mockResolvedValue({ requiresApiVersion: 16, projectRows: useProjectRowContribution });
  });

  it('reads all managed states and resource bars in one batch', async () => {
    mount();
    const running = await screen.findAllByRole('img', { name: strings.state_running });
    const stopped = await screen.findAllByRole('img', { name: strings.state_stopped });
    expect(running.length).toBeGreaterThan(0);
    expect(stopped.length).toBeGreaterThan(0);
    expect(running[0]).toHaveClass('lucide-play');
    expect(stopped[0]).toHaveClass('lucide-square');
    await waitFor(() => expect(usageRequests).toEqual([[3, 5]]));

    const runningRow = screen.getByRole('button', { name: 'Open project analysis' }).closest('[role="row"]') as HTMLElement;
    expect(within(runningRow).getAllByRole('progressbar', { name: strings.usageCpu }).at(0)).toHaveAttribute('aria-valuenow', '50');
    expect(within(runningRow).getAllByRole('progressbar', { name: strings.usageRam }).at(0)).toHaveAttribute('aria-valuetext', expect.stringContaining('256 MiB / 1 GiB'));
    expect([...runningRow.querySelectorAll('[title]')].some((element) => element.getAttribute('title')?.includes(strings.usageLimitUnknown))).toBe(true);
    expect(runningRow.querySelector('[data-project-row-metrics][data-compact="true"]')).not.toBeNull();

    const stoppedRow = screen.getByRole('button', { name: 'Open project reports' }).closest('[role="row"]') as HTMLElement;
    expect(within(stoppedRow).getAllByText(strings.usageStopped).length).toBeGreaterThan(0);
    expect(within(stoppedRow).queryByRole('progressbar', { name: strings.usageCpu })).toBeNull();

    const hostRow = screen.getByRole('button', { name: 'Open project elowen' }).closest('[role="row"]') as HTMLElement;
    expect(within(hostRow).queryByRole('img', { name: strings.state_running })).toBeNull();
    expect(hostRow.querySelector('[data-project-row-metrics]')).toBeNull();
    expect(within(hostRow).queryByRole('menuitem')).toBeNull();
  });

  it('uses warning and danger tokens at the resource thresholds', async () => {
    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
      const { projectIds } = await request.json() as { projectIds: number[] };
      return HttpResponse.json({ sampledAt: '2026-01-01T00:00:00.000Z', projects: projectIds.map((projectId) => {
        const item = usageOf(projectId, projectId === 3 ? 'running' : 'stopped');
        if (projectId === 3) {
          item.resources.cpu.percent = 95;
          item.resources.memory.usedBytes = 768 * 1024 * 1024;
        }
        return item;
      }) });
    }));
    mount();
    const row = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[role="row"]') as HTMLElement;
    const cpu = (await within(row).findAllByRole('progressbar', { name: strings.usageCpu }))[0]!;
    const ram = within(row).getAllByRole('progressbar', { name: strings.usageRam })[0]!;
    // The meter is the shared shadcn `Progress`, so the fill is its indicator slot rather than a bare span.
    expect(cpu.querySelector('[data-slot="progress-indicator"]')).toHaveClass('bg-destructive');
    expect(ram.querySelector('[data-slot="progress-indicator"]')).toHaveClass('bg-warning');
  });

  it('keeps stable unavailable bars when the batch loses access', async () => {
    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', () => HttpResponse.json({ error: 'project_forbidden' }, { status: 403 })));
    mount();
    const values = await screen.findAllByText(strings.error_project_forbidden);
    expect(values.length).toBeGreaterThan(0);
    expect(screen.queryByRole('progressbar', { name: strings.usageCpu })).toBeNull();
  });

  // A refusal is not a failed read: the daemon re-resolves membership on every batch so that a revoked
  // assignment stops reading host resource counters, and a browser holding the last sample must not
  // undo that. Every OTHER failure keeps its figures (see the stale-refresh spec below).
  it('does not let cached metrics overwrite a refused refetch', async () => {
    mount();
    await screen.findAllByRole('progressbar', { name: strings.usageCpu });
    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', () => HttpResponse.json({ error: 'project_forbidden' }, { status: 403 })));
    fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: strings.startEnvironment }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((await screen.findAllByText(strings.error_project_forbidden)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('progressbar', { name: strings.usageCpu })).toBeNull();
  });

  // A refusal fences the read this page is making. A cache entry left behind by an EARLIER project set —
  // a register that still had one more project on it, or one keyed on whatever the filter box left — would
  // otherwise sit there intact, ready to answer the moment anything selected it again.
  it('removes every other resource cache of the plugin when the account is refused', async () => {
    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', () => HttpResponse.json({ error: 'project_forbidden' }, { status: 403 })));
    const { wrapper: Wrapper, client } = createWrapper();
    const stalePageKey = ['plugin', 'sandbox', 'project-row-usage', 3];
    client.setQueryData(stalePageKey, { sampledAt: '2026-01-01T00:00:00.000Z', projects: [usageOf(3, 'running')] });
    const usageKeys = () => client.getQueryCache().getAll().map((query) => query.queryKey)
      .filter((key) => Array.isArray(key) && key[0] === 'plugin' && key[1] === 'sandbox' && key[2] === 'project-row-usage');
    expect(usageKeys()).toHaveLength(1);

    render(<Wrapper><ToastProvider><ProjectsView /></ToastProvider></Wrapper>);
    expect((await screen.findAllByText(strings.error_project_forbidden)).length).toBeGreaterThan(0);

    await waitFor(() => expect(usageKeys()).toEqual([['plugin', 'sandbox', 'project-row-usage', 3, 5]]));
    expect(client.getQueryData(stalePageKey)).toBeUndefined();
  });

  // The drawer opens over a row whose CPU, memory and disk are already on screen. It renders THAT frame,
  // so the figures are there in the same commit as the drawer — no second request, and no spinner
  // replacing numbers the reader can still see behind the rail.
  it('hydrates the project drawer from the row snapshot instead of reading again', async () => {
    mount();
    const row = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[role="row"]') as HTMLElement;
    await waitFor(() => expect(within(row).getAllByRole('progressbar', { name: strings.usageCpu }).length).toBeGreaterThan(0));
    await waitFor(() => expect(usageRequests).toEqual([[3, 5]]));

    fireEvent.click(screen.getByRole('button', { name: 'Open project analysis' }));

    const panel = document.querySelector('[data-project-resource-panel]') as HTMLElement;
    expect(panel, 'the drawer carries the resource panel').not.toBeNull();
    expect(within(panel).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50');
    expect(within(panel).getByRole('progressbar', { name: strings.usageRam })).toHaveAttribute('aria-valuetext', expect.stringContaining('256 MiB / 1 GiB'));
    // The disk figure the whole-directory measurement produces reaches the drawer as measured bytes.
    expect(within(panel).getByText('512 MiB')).toBeInTheDocument();
    expect(within(panel).queryByRole('status')).toBeNull();
    expect(usageRequests).toEqual([[3, 5]]);
  });

  // A revalidation keeps every figure it already has. A FAILED one keeps them too and says they are the
  // last known ones: replacing a real measurement with "Unavailable" because one poll missed is how a
  // populated environment kept reporting nothing.
  it('keeps the measured figures through a refresh and marks a failed one stale', async () => {
    mount();
    await screen.findAllByRole('progressbar', { name: strings.usageCpu });
    const open = screen.getByRole('button', { name: 'Open project analysis' });
    // Held before the rail opens: the register behind an open drawer is marked inert, so a role query
    // would no longer reach the row.
    const row = open.closest('[role="row"]') as HTMLElement;
    fireEvent.click(open);
    const panel = document.querySelector('[data-project-resource-panel]') as HTMLElement;

    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', () => HttpResponse.json({ error: 'sampling failed' }, { status: 503 })));
    fireEvent.click(within(panel).getByRole('button', { name: strings.usageRefresh }));

    await waitFor(() => expect(panel.querySelector('[data-project-row-metrics][data-stale="true"]')).not.toBeNull());
    // Still the measured values, not zeros and not a placeholder.
    expect(within(panel).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50');
    expect(within(panel).getByText('512 MiB')).toBeInTheDocument();
    expect(within(panel).getByText(strings.usageStale!)).toBeInTheDocument();
    expect(within(panel).queryByText(strings.usageUnavailable!)).toBeNull();
    // The row behind it agrees: one snapshot, two surfaces.
    expect(row.querySelector('[data-project-row-metrics][data-stale="true"]')).not.toBeNull();
  });

  /** Replace one resource of the batch, keeping the `200` and every other figure intact. This is the
   *  failure the host actually produces: an unreadable cgroup file or an unwalkable disk tree is reported
   *  INSIDE a successful answer, per resource, not as a failed request. */
  const usageWithout = (...kinds: ('cpu' | 'memory' | 'disk')[]) =>
    http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
      const { projectIds } = await request.json() as { projectIds: number[] };
      usageRequests.push(projectIds);
      return HttpResponse.json({ sampledAt: '2026-01-01T00:00:01.000Z', projects: projectIds.map((projectId) => {
        const item = usageOf(projectId, projectId === 3 ? 'running' : 'stopped') as any;
        for (const kind of kinds) item.resources[kind] = { state: 'unavailable', usedCpus: null, percent: null, usedBytes: null, limitBytes: null };
        return item;
      }) });
    });

  // The batch answers `200` with a per-resource `unavailable` far more often than it fails outright. A
  // disk tree the helper could not walk must not wipe the figure measured a moment earlier: the reading
  // stays, marked as the last known one.
  it('keeps a measured disk when a successful batch reports that one resource is unavailable', async () => {
    mount();
    const row = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[role="row"]') as HTMLElement;
    // Two copies of the same snapshot live on the row: the compact one in the identity cell and the one
    // in the Resources column.
    await waitFor(() => expect(within(row).getAllByText('512 MiB').length).toBe(2));

    server.use(usageWithout('disk'));
    fireEvent.click(screen.getByRole('button', { name: 'Open project analysis' }));
    const panel = document.querySelector('[data-project-resource-panel]') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: strings.usageRefresh }));

    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await waitFor(() => expect(panel.querySelector('[data-project-row-metrics][data-stale="true"]')).not.toBeNull());
    const disk = panel.querySelector('[data-metric="disk"]') as HTMLElement;
    expect(within(disk).getByText('512 MiB')).toBeInTheDocument();
    expect(disk).toHaveAttribute('data-metric-state', 'absolute');
    expect(within(disk).queryByText(strings.usageUnavailable!)).toBeNull();
    // The request SUCCEEDED, so the rest of it is current: only the mark says a figure is older.
    expect(within(panel).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50');
    expect(within(panel).getByText(strings.usageStale!)).toBeInTheDocument();
  });

  it('keeps measured CPU and memory when the cgroup read fails inside a successful batch', async () => {
    mount();
    const row = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[role="row"]') as HTMLElement;
    await waitFor(() => expect(within(row).getAllByRole('progressbar', { name: strings.usageCpu }).length).toBeGreaterThan(0));

    server.use(usageWithout('cpu', 'memory'));
    fireEvent.click(screen.getByRole('button', { name: 'Open project analysis' }));
    const panel = document.querySelector('[data-project-resource-panel]') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: strings.usageRefresh }));

    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await waitFor(() => expect(panel.querySelector('[data-project-row-metrics][data-stale="true"]')).not.toBeNull());
    expect(within(panel).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50');
    expect(within(panel).getByRole('progressbar', { name: strings.usageRam })).toHaveAttribute('aria-valuetext', expect.stringContaining('256 MiB / 1 GiB'));
    expect(within(panel).queryByText(strings.usageUnavailable!)).toBeNull();
  });

  // Preserving a figure is only honest when there IS one. A resource that has never been measured says
  // so, rather than showing a blank meter that could be read as zero.
  it('states unavailable for a resource no good value was ever measured for', async () => {
    server.use(usageWithout('disk'));
    mount();
    const row = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[role="row"]') as HTMLElement;
    await waitFor(() => expect(row.querySelector('[data-metric="disk"]')).not.toBeNull());
    const disk = row.querySelector('[data-metric="disk"]') as HTMLElement;

    expect(disk).toHaveAttribute('data-metric-state', 'unavailable');
    expect(within(disk).getByText(strings.usageUnavailable!)).toBeInTheDocument();
    // Nothing was kept, so nothing is claimed to be older than it is.
    expect(row.querySelector('[data-project-row-metrics][data-stale="true"]')).toBeNull();
  });

  // The resource read belongs to the PAGE, not to whatever the filter box currently leaves on screen.
  // Keying it on the filtered rows gave every keystroke its own cache entry and its own host measurement,
  // and emptied the open drawer the moment its project stopped matching.
  it('keeps the open drawer snapshot and issues no further batch when the register is filtered', async () => {
    mount();
    await screen.findAllByRole('progressbar', { name: strings.usageCpu });
    await waitFor(() => expect(usageRequests).toEqual([[3, 5]]));
    fireEvent.click(screen.getByRole('button', { name: 'Open project analysis' }));
    const panel = document.querySelector('[data-project-resource-panel]') as HTMLElement;

    // A search that matches the HOST project alone, so the open managed project is no longer a row.
    fireEvent.change(screen.getByLabelText('Search projects'), { target: { value: 'elowen' } });

    await waitFor(() => expect(within(panel).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50'));
    expect(within(panel).getByText('512 MiB')).toBeInTheDocument();
    expect(usageRequests).toEqual([[3, 5]]);
  });

  // The control exists to produce ONE fresh measurement. React Query's default cancels a read in flight
  // and starts another, so an impatient reader used to bill the host one whole sweep per click.
  it('produces a single backend read however often refresh is pressed', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mount();
    await screen.findAllByRole('progressbar', { name: strings.usageCpu });
    await waitFor(() => expect(usageRequests).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Open project analysis' }));
    const panel = document.querySelector('[data-project-resource-panel]') as HTMLElement;

    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
      const { projectIds } = await request.json() as { projectIds: number[] };
      usageRequests.push(projectIds);
      await gate;
      return HttpResponse.json({ sampledAt: '2026-01-01T00:00:02.000Z', projects: projectIds
        .map((projectId) => usageOf(projectId, projectId === 3 ? 'running' : 'stopped')) });
    }));

    const button = within(panel).getByRole('button', { name: strings.usageRefresh });
    fireEvent.click(button);
    await waitFor(() => expect(usageRequests).toHaveLength(2));
    // While that read is in flight the control is not offering a second one, and a click that reaches it
    // anyway is refused by `cancelRefetch: false` rather than starting a competing sweep.
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    fireEvent.click(button);
    release?.();

    await waitFor(() => expect(button).toBeEnabled());
    expect(usageRequests).toHaveLength(2);
    expect(within(panel).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50');
  });

  // A managed environment has no disk quota, so there is no denominator. The used figure is complete on
  // its own and is reported as itself — never `1.2 GiB / ?`, never a percentage of nothing, and never
  // hidden, because the measurement is real.
  it('reports a disk with no configured ceiling as an absolute figure', async () => {
    mount();
    const row = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[role="row"]') as HTMLElement;
    await waitFor(() => expect(row.querySelector('[data-metric="disk"]')).not.toBeNull());
    const disk = row.querySelector('[data-metric="disk"]') as HTMLElement;

    expect(disk).toHaveAttribute('data-metric-state', 'absolute');
    expect(within(disk).getByText('512 MiB')).toBeInTheDocument();
    expect(row.textContent).not.toContain('/ ?');
    // No meter at all: a bar would claim a proportion of a ceiling that does not exist.
    expect(within(disk).queryByRole('progressbar')).toBeNull();
    expect(disk.querySelector('[data-metric-track="none"]')).not.toBeNull();
    expect(disk.getAttribute('title')).toContain(strings.usageLimitUnknown);
  });

  // The Resources column is wide-only, so on a tablet and a phone the same meters have to travel with
  // the identity cell — otherwise the one thing a managed row is worth opening for disappears with the
  // column. Both copies are the same snapshot, and neither of them may overflow its track.
  it('carries the meters in their own column when wide and inside the identity cell when not', async () => {
    mount();
    const row = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[role="row"]') as HTMLElement;
    await waitFor(() => expect(row.querySelectorAll('[data-project-row-metrics]')).toHaveLength(2));
    const [identity, wide] = [...row.querySelectorAll('[data-project-row-metrics]')] as HTMLElement[];

    expect(identity).toHaveAttribute('data-compact', 'true');
    expect(identity.closest('[data-priority="wide"]')).toBeNull();
    expect(identity.parentElement?.className).toContain('@min-[56rem]:hidden');
    expect(wide).not.toHaveAttribute('data-compact');
    expect(wide.closest('[data-priority="wide"]')).not.toBeNull();

    // Three equal tracks that may shrink, and every reading clipped inside its own track rather than
    // pushing the row wider.
    for (const group of [identity, wide]) {
      expect(group.className).toContain('grid-cols-3');
      expect(group.className).toContain('min-w-0');
      for (const metric of group.querySelectorAll('[data-metric]')) {
        expect(metric.className).toContain('min-w-0');
        expect(metric.querySelector('.truncate')).not.toBeNull();
      }
    }

    // The register's own tracks: identity, team, resources, state, actions, chevron when wide; the
    // identity column alone plus those three narrow tracks when not.
    const table = screen.getByTestId('projects-register');
    expect(table.style.getPropertyValue('--data-table-columns').trim().split(/\s+(?![^(]*\))/)).toHaveLength(6);
    expect(table.style.getPropertyValue('--data-table-compact-columns').trim().split(/\s+(?![^(]*\))/)).toHaveLength(4);
  });

  it('uses a calm foreground-only polling policy', () => {
    expect(PROJECT_USAGE_QUERY_POLICY).toEqual({
      staleTime: 25_000,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
    });
  });

  it('enables each lifecycle action by the state the environment is actually in', async () => {
    mount();
    await screen.findAllByRole('img', { name: strings.state_running });

    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    await screen.findAllByRole('menuitem');
    expect(screen.getByRole('menuitem', { name: strings.startEnvironment })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: strings.stopEnvironment })).not.toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: strings.restartEnvironment })).not.toHaveAttribute('data-disabled');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));

    fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
    await screen.findAllByRole('menuitem');
    expect(screen.getByRole('menuitem', { name: strings.startEnvironment })).not.toHaveAttribute('data-disabled');
    // A stopped environment cannot be stopped again; the item stays in place and refuses.
    expect(screen.getByRole('menuitem', { name: strings.stopEnvironment })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: strings.snapshotEnvironment })).not.toHaveAttribute('data-disabled');
  });

  it('starts a stopped environment from the row and follows the durable operation', async () => {
    mount();
    await screen.findAllByRole('img', { name: strings.state_stopped });
    fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: strings.startEnvironment }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      projectId: 5,
      body: { action: { kind: 'start' }, requestId: expect.any(String), expectedGeneration: 2 },
    });
    // The same progress window every other lifecycle surface raises, on the same durable row.
    expect(await screen.findByTestId('operation-progress-dialog')).toBeInTheDocument();
    expect(await screen.findByText('Creating the container')).toBeInTheDocument();
  });

  // A lost response must not queue a second start when the person tries again: the idempotency key is
  // persisted with the intent and reused until the daemon acknowledges it.
  it('reuses the persisted request identity after a lost response', async () => {
    const requests: { requestId: string; expectedGeneration: number }[] = [];
    server.use(http.post('*/api/plugins/sandbox/api/projects/5/environment', async ({ request }) => {
      const body = await request.json() as { requestId: string; expectedGeneration: number };
      requests.push(body);
      if (requests.length === 1) return HttpResponse.json({ error: 'Response lost' }, { status: 503 });
      return HttpResponse.json({ id: 'op-1', requestId: body.requestId, projectId: 5, generation: 2, accountUserId: 1, action: { kind: 'start' }, status: 'pending', error: null });
    }));
    mount();
    await screen.findAllByRole('img', { name: strings.state_stopped });

    for (const attempt of [1, 2]) {
      fireEvent.click(screen.getByRole('button', { name: 'reports: Actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: strings.startEnvironment }));
      await waitFor(() => expect(requests).toHaveLength(attempt));
    }
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0]?.requestId).toEqual(expect.any(String));
  });

  // A refused action used to be swallowed into a toast while the confirmation stayed open explaining
  // nothing. It is reported where it was raised, and the intent stays unacknowledged so a retry keeps
  // the same identity.
  it('shows a refused action inside the confirmation that raised it', async () => {
    server.use(http.post('*/api/plugins/sandbox/api/projects/3/environment', () => HttpResponse.json({ error: 'environment_busy' }, { status: 409 })));
    mount();
    await screen.findAllByRole('img', { name: strings.state_running });
    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: strings.stopEnvironment }));

    const dialog = within(await screen.findByRole('alertdialog'));
    fireEvent.click(dialog.getByRole('button', { name: strings.stopEnvironment }));
    expect(await dialog.findByText('environment_busy')).toBeInTheDocument();
    expect(localStorage.getItem('elowen.environment-request:1:3')).not.toBeNull();
  });

  it('asks before stopping a running environment, and sends nothing until it is confirmed', async () => {
    mount();
    await screen.findAllByRole('img', { name: strings.state_running });
    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: strings.stopEnvironment }));

    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText(strings.stopWarning!)).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    fireEvent.click(dialog.getByRole('button', { name: strings.stopEnvironment }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.body).toEqual({ action: { kind: 'stop' }, requestId: expect.any(String), expectedGeneration: 2 });
  });
});
