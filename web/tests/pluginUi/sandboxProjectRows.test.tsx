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
import { usageProgressColour } from '../../modules/settings/OAuthUsageRail';
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

describe('sandbox contribution to the Project register cards', () => {
  beforeEach(() => {
    posted = [];
    usageRequests = [];
    loadPluginUi.mockReset();
    // Exactly what the built bundle registers, running against the real host runtime.
    loadPluginUi.mockResolvedValue({ requiresApiVersion: 16, projectRows: useProjectRowContribution });
  });

  it('reads all managed states and resource bars in one batch', async () => {
    mount();
    const running = await screen.findAllByText(strings.state_running!);
    const stopped = await screen.findAllByText(strings.state_stopped!);
    expect(running.length).toBeGreaterThan(0);
    expect(stopped.length).toBeGreaterThan(0);
    expect(running[0]!.closest('[data-project-row-status]')!.querySelector('svg')).toHaveClass('lucide-play');
    expect(stopped[0]!.closest('[data-project-row-status]')!.querySelector('svg')).toHaveClass('lucide-square');
    await waitFor(() => expect(usageRequests).toEqual([[3, 5]]));

    const runningCard = screen.getByRole('button', { name: 'Open project analysis' }).closest('[data-project-card]') as HTMLElement;
    expect(within(runningCard).getAllByRole('progressbar', { name: strings.usageCpu }).at(0)).toHaveAttribute('aria-valuenow', '50');
    expect(within(runningCard).getAllByRole('progressbar', { name: strings.usageRam }).at(0)).toHaveAttribute('aria-valuetext', expect.stringContaining('256 MiB / 1 GiB'));
    expect([...runningCard.querySelectorAll('[title]')].some((element) => element.getAttribute('title')?.includes(strings.usageLimitUnknown))).toBe(true);
    // ONE snapshot per card. The row had to draw the meters twice, once in a wide-only column and once
    // folded back into the identity cell; a card has a place for them and needs neither copy.
    expect(runningCard.querySelectorAll('[data-project-row-metrics]')).toHaveLength(1);

    const stoppedCard = screen.getByRole('button', { name: 'Open project reports' }).closest('[data-project-card]') as HTMLElement;
    expect(within(stoppedCard).getAllByText(strings.usageStopped).length).toBeGreaterThan(0);
    expect(within(stoppedCard).queryByRole('progressbar', { name: strings.usageCpu })).toBeNull();

    // A host project has no container, so it has no state, no meters and no lifecycle actions — and it
    // says that in words rather than showing three empty bars that could be read as zero.
    const hostCard = screen.getByRole('button', { name: 'Open project elowen' }).closest('[data-project-card]') as HTMLElement;
    expect(hostCard.querySelector('[data-project-row-status]')).toBeNull();
    expect(hostCard.querySelector('[data-project-row-metrics]')).toBeNull();
    expect(hostCard.querySelector('[data-project-host-state]')).not.toBeNull();
    expect(within(hostCard).getByText('Host project')).toBeInTheDocument();
    expect(within(hostCard).queryByRole('progressbar')).toBeNull();
    expect(within(hostCard).queryByRole('menuitem')).toBeNull();
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
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    const cpu = (await within(card).findAllByRole('progressbar', { name: strings.usageCpu }))[0]!;
    const ram = within(card).getAllByRole('progressbar', { name: strings.usageRam })[0]!;
    // The meter is a chart now, and a chart has no measurable size in jsdom — so the assertion is on what
    // the register actually decides: the reading it hands the meter, and the tone that reading maps to.
    // The fill itself is `usageProgressColour`'s single ramp, covered where that ramp lives.
    expect(cpu).toHaveAttribute('aria-valuenow', '95');
    expect(usageProgressColour(95)).toBe('var(--color-destructive)');
    expect(ram).toHaveAttribute('aria-valuenow', '75');
    expect(usageProgressColour(75)).toBe('var(--color-warning)');
  });

  /** Disk used to be the one reading the register could not draw: measured, but with nothing to be a
   *  fraction of. The runtime now reports the volume the environment is stored on, which is a ceiling it
   *  genuinely cannot grow past, so the card draws all three with the same meter — and says in the
   *  accessible text which ceiling it is, because a volume is not a Project quota. */
  /** Half a gigabyte of a 200 GB volume is a real reading that rounds away. The ring lifts it to a visible
   *  floor so a barely-used resource never looks untouched, and the figure beside it has to agree: an arc
   *  on screen next to `0%` reads as a drawing error rather than as a small number. */
  it('says a fraction below one per cent is under one, not zero', async () => {
    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
      const { projectIds } = await request.json() as { projectIds: number[] };
      return HttpResponse.json({ sampledAt: '2026-01-01T00:00:00.000Z', projects: projectIds.map((projectId) => {
        const item = usageOf(projectId, projectId === 3 ? 'running' : 'stopped') as any;
        if (projectId === 3) {
          Object.assign(item.resources.disk, { state: 'ready', usedBytes: 512 * 1024 * 1024, limitBytes: 200 * 1024 * 1024 * 1024 });
          item.resources.cpu.percent = 0;
        }
        return item;
      }) });
    }));
    mount();
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    const disk = await waitFor(() => {
      const found = card.querySelector('[data-metric="disk"]') as HTMLElement | null;
      expect(found).toHaveAttribute('data-metric-state', 'ready');
      return found!;
    });
    expect(within(disk).getByText('<1%')).toBeInTheDocument();
    expect(disk.querySelector('.metric-donut-arc'), 'a real reading was rounded away to nothing').not.toBeNull();
    // An exact zero is the one reading with no arc, and it keeps saying zero.
    const cpu = card.querySelector('[data-metric="cpu"]') as HTMLElement;
    expect(within(cpu).getByText('0%')).toBeInTheDocument();
    expect(cpu.querySelector('.metric-donut-arc'), 'an idle resource was drawn as if it were in use').toBeNull();
  });

  it('gives disk the same meter as RAM once the runtime reports the volume it sits on', async () => {
    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
      const { projectIds } = await request.json() as { projectIds: number[] };
      return HttpResponse.json({ sampledAt: '2026-01-01T00:00:00.000Z', projects: projectIds.map((projectId) => {
        const item = usageOf(projectId, projectId === 3 ? 'running' : 'stopped');
        if (projectId === 3) Object.assign(item.resources.disk, { state: 'ready', usedBytes: 512 * 1024 * 1024, limitBytes: 200 * 1024 * 1024 * 1024 });
        return item;
      }) });
    }));
    mount();
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    const disk = await waitFor(() => {
      const found = card.querySelector('[data-metric="disk"]') as HTMLElement | null;
      expect(found).toHaveAttribute('data-metric-state', 'ready');
      return found!;
    });
    // The exact figures, both of them measured: nothing here is normalized against another project.
    expect(within(disk).getByText('512 MiB / 200 GiB')).toBeInTheDocument();
    // A ceiling that exists means an arc against it, where an absolute figure leaves the ring empty.
    expect(disk.querySelector('.metric-donut-arc')).not.toBeNull();
    const meter = within(disk).getByRole('progressbar', { name: strings.usageDisk });
    expect(meter).toHaveAttribute('aria-valuenow', '0');
    expect(meter).toHaveAttribute('aria-valuetext', expect.stringContaining(strings.usageDiskVolume!));
    // RAM is the same grammar against a different ceiling, and its text says nothing about a volume.
    expect(within(card).getByRole('progressbar', { name: strings.usageRam }))
      .toHaveAttribute('aria-valuetext', `${strings.usageRam}: 256 MiB / 1 GiB`);
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
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(within(card).getAllByRole('progressbar', { name: strings.usageCpu }).length).toBeGreaterThan(0));
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
    // would no longer reach the card.
    const card = open.closest('[data-project-card]') as HTMLElement;
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
    // The card behind it agrees: one snapshot, two surfaces.
    expect(card.querySelector('[data-project-row-metrics][data-stale="true"]')).not.toBeNull();
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
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    // ONE copy of the snapshot per card, where a row had to carry two.
    await waitFor(() => expect(within(card).getAllByText('512 MiB')).toHaveLength(1));

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
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(within(card).getAllByRole('progressbar', { name: strings.usageCpu }).length).toBeGreaterThan(0));

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
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(card.querySelector('[data-metric="disk"]')).not.toBeNull());
    const disk = card.querySelector('[data-metric="disk"]') as HTMLElement;

    expect(disk).toHaveAttribute('data-metric-state', 'unavailable');
    expect(within(disk).getByText(strings.usageUnavailable!)).toBeInTheDocument();
    // Nothing was kept, so nothing is claimed to be older than it is.
    expect(card.querySelector('[data-project-row-metrics][data-stale="true"]')).toBeNull();
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
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(card.querySelector('[data-metric="disk"]')).not.toBeNull());
    const disk = card.querySelector('[data-metric="disk"]') as HTMLElement;

    expect(disk).toHaveAttribute('data-metric-state', 'absolute');
    expect(within(disk).getByText('512 MiB')).toBeInTheDocument();
    expect(card.textContent).not.toContain('/ ?');
    // The ring keeps its shape, and the arc that would claim a proportion of a ceiling that does not
    // exist is simply not drawn. The sentence saying WHY is what a screen reader gets for the ring's name.
    expect(within(disk).queryByRole('progressbar')).toBeNull();
    expect(disk.querySelector('.metric-donut-track')).not.toBeNull();
    expect(disk.querySelector('.metric-donut-arc')).toBeNull();
    expect(within(disk).getByRole('img').getAttribute('aria-label')).toContain(strings.usageLimitUnknown);
    expect(disk.getAttribute('title')).toContain(strings.usageLimitUnknown);
  });

  /** ONE strip, one arrangement, in the card and in the drawer alike.
   *
   *  The card used to stack the three meters and the drawer used to set them three abreast, because a
   *  horizontal bar needs a track as wide as it can get and a stack was the only way to give each one the
   *  card's whole width. A ring needs a square instead, so the two surfaces stopped needing different
   *  answers: three equal donuts in one row read as a single instrument rather than a list to work
   *  through, which is what a reader scanning a register is actually doing. */
  it('draws one three-abreast strip per snapshot, in the card and in the drawer alike', async () => {
    mount();
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(card.querySelectorAll('[data-project-row-metrics]')).toHaveLength(1));
    const inCard = card.querySelector('[data-project-row-metrics]') as HTMLElement;

    expect(inCard.className).toContain('grid-cols-3');
    expect(inCard.className).toContain('min-w-0');
    // A calm strip, not three dashboard tiles: no border, no surface, no shadow of its own.
    expect(inCard.className).not.toMatch(/\bborder|\bshadow|\brounded|\bbg-/);
    // Every reading clipped inside its own column rather than pushing the card wider.
    for (const metric of inCard.querySelectorAll('[data-metric]')) {
      expect(metric.className).toContain('min-w-0');
      expect(metric.querySelector('.truncate')).not.toBeNull();
    }
    expect([...inCard.querySelectorAll('[data-metric]')].map((metric) => metric.getAttribute('data-metric'))).toEqual(['cpu', 'memory', 'disk']);
    for (const label of [strings.usageCpu, strings.usageRam, strings.usageDisk]) {
      expect(within(inCard).getByText(label!)).toBeInTheDocument();
    }
    // CPU's own reading IS the percentage in the hole, so it is not also printed underneath; RAM's exact
    // pair says more than its percentage does and is.
    expect(within(inCard).getByText('50%')).toBeInTheDocument();
    expect(within(inCard).getAllByText('50%')).toHaveLength(1);
    expect(within(inCard).getByText('256 MiB / 1 GiB')).toBeInTheDocument();
    expect(within(inCard).getByText('25%'), 'RAM states its proportion in the hole').toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open project analysis' }));
    const panel = document.querySelector('[data-project-resource-panel] [data-project-row-metrics]') as HTMLElement;
    expect(panel.className).toContain('grid-cols-3');
    expect(panel.querySelectorAll('[data-metric]')).toHaveLength(3);
  });

  // The register is a grid of cards whose column count follows its CONTAINER, not the viewport: the same
  // surface is rendered at very different widths, and three cards across a phone is the failure these
  // breakpoints exist to prevent. Three is the ceiling; a fourth column takes a card below the width its
  // exact figures need.
  it('lays the register out as one, two or three cards by container width', async () => {
    mount();
    await screen.findAllByText(strings.state_running!);
    const grid = screen.getByTestId('projects-register');

    expect(grid).toHaveAttribute('role', 'list');
    expect(grid.className).toContain('@container');
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('@min-[38rem]:grid-cols-2');
    expect(grid.className).toContain('@min-[58rem]:grid-cols-3');
    expect(grid.className).not.toContain('grid-cols-4');
    // Every card is a list item of that list, and each one is min-width-0 so a long slug cannot widen
    // its column and push the grid out of the surface.
    const items = [...grid.children] as HTMLElement[];
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item).toHaveAttribute('role', 'listitem');
      expect(item.className).toContain('min-w-0');
      expect(item.querySelector('[data-project-card]')).not.toBeNull();
    }
  });

  /** THE ARRIVAL ORDER. A card is drawn from the core Project list; CPU, RAM and disk come from this
   *  plugin's own batch, which cannot even start until the bundle has been imported and then has to wait
   *  out a real measurement of the host. So there is a window in which the card is on screen and the
   *  figures are not, and the register used to fill it with the word "Loading" in all three slots.
   *
   *  A register is read by scanning it for the project that is misbehaving, and three cards each saying
   *  "Loading" three times is the opposite of that. The strip is therefore drawn in its FINAL geometry
   *  from the first commit, saying it does not know yet — and the measurement replaces the unknown value
   *  inside the very same elements when it lands, so nothing moves under the reader. */
  it('draws the strip in its final geometry, with no loading prose, before the first sample', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
      const { projectIds } = await request.json() as { projectIds: number[] };
      usageRequests.push(projectIds);
      await gate;
      return HttpResponse.json({ sampledAt: '2026-01-01T00:00:00.000Z', projects: projectIds
        .map((projectId) => usageOf(projectId, projectId === 3 ? 'running' : 'stopped')) });
    }));
    mount();
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(card.querySelectorAll('[data-metric]')).toHaveLength(3));

    // Never a wait in words, in any slot of any card, and never a live region announcing one either.
    // Matched against the document rather than a string key, because the point is that no such wording
    // exists to be reintroduced — the strings themselves were removed with the placeholder.
    expect(document.body.textContent).not.toMatch(/loading|načítání|sampling|měření/i);
    expect(document.querySelector('[role="status"]')).toBeNull();
    // The geometry is already the final one: three donuts, each with its quiet remaining track drawn and
    // no used arc, because nothing has been measured to draw one from.
    const held: Record<string, Element> = {};
    for (const kind of ['cpu', 'memory', 'disk']) {
      const cell = card.querySelector(`[data-metric="${kind}"]`) as HTMLElement;
      expect(cell, kind).toHaveAttribute('data-metric-state', 'unknown');
      expect(cell.querySelector('.metric-donut-track'), `${kind} has no track`).not.toBeNull();
      expect(cell.querySelector('.metric-donut-arc'), `${kind} invented a reading`).toBeNull();
      // ONE honest mark, in the ring. Repeating it on the line below would be two ways of saying nothing.
      expect(within(cell).getAllByText('—'), `${kind} says it twice`).toHaveLength(1);
      held[kind] = cell;
    }

    release?.();
    await waitFor(() => expect(card.querySelector('[data-metric="cpu"]')).toHaveAttribute('data-metric-state', 'ready'));
    // Replaced IN PLACE. A remount here is what makes a register of cards flicker every poll.
    for (const kind of ['cpu', 'memory', 'disk']) {
      expect(card.querySelector(`[data-metric="${kind}"]`), `${kind} remounted`).toBe(held[kind]);
    }
    expect(within(card).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50');
  });

  /** Registering or deleting a managed project changes the batch's cache key, and a new key has no data of
   *  its own. Without carrying the last snapshot across that change, the whole register emptied back to
   *  unknown rings for the length of one measurement because ONE project joined it. */
  it('carries the last snapshot across a change of the observed project set', async () => {
    const client = mount();
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(within(card).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50'));
    expect(usageRequests).toEqual([[3, 5]]);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    server.use(
      http.get('*/api/projects', () => HttpResponse.json([...projects, { id: 9, slug: 'nove', path: '', notes: '', icon: '', executionKind: 'managed' }])),
      http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
        const { projectIds } = await request.json() as { projectIds: number[] };
        usageRequests.push(projectIds);
        await gate;
        return HttpResponse.json({ sampledAt: '2026-01-01T00:00:01.000Z', projects: projectIds
          .map((projectId) => usageOf(projectId, projectId === 3 ? 'running' : 'stopped')) });
      }),
    );
    await client.invalidateQueries({ queryKey: ['projects'] });

    // The batch for the new set is in flight, and the measured CPU of the project that was already on
    // screen is still on screen rather than blanked back to an unknown ring.
    await waitFor(() => expect(usageRequests).toEqual([[3, 5], [3, 5, 9]]));
    expect(within(card).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50');
    expect(card.querySelector('[data-project-row-metrics]')).toHaveAttribute('data-refreshing', 'true');
    // The project nothing has ever been measured for says exactly that, in the same geometry.
    const fresh = await waitFor(() => {
      const found = (screen.getByRole('button', { name: 'Open project nove' }).closest('[data-project-card]') as HTMLElement)
        .querySelector('[data-metric="cpu"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(fresh).toHaveAttribute('data-metric-state', 'unknown');
    release?.();
    await waitFor(() => expect(fresh).toHaveAttribute('data-metric-state', 'stopped'));
  });

  /** A container that is being recreated is a NEW process with a new generation, and the CPU and memory of
   *  the one before it are not its figures. Disk is storage rather than process state and survives. */
  it('never shows another generation of the environment its process figures', async () => {
    mount();
    const card = (await screen.findByRole('button', { name: 'Open project analysis' })).closest('[data-project-card]') as HTMLElement;
    await waitFor(() => expect(within(card).getByRole('progressbar', { name: strings.usageCpu })).toHaveAttribute('aria-valuenow', '50'));

    server.use(http.post('*/api/plugins/sandbox/api/environments/usage', async ({ request }) => {
      const { projectIds } = await request.json() as { projectIds: number[] };
      usageRequests.push(projectIds);
      return HttpResponse.json({ sampledAt: '2026-01-01T00:00:02.000Z', projects: projectIds.map((projectId) => {
        const item = usageOf(projectId, projectId === 3 ? 'running' : 'stopped') as any;
        if (projectId === 3) {
          item.environment.generation = 3;
          item.resources.cpu = { state: 'unavailable', usedCpus: null, percent: null };
          item.resources.memory = { state: 'unavailable', usedBytes: null, limitBytes: null };
        }
        return item;
      }) });
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Open project analysis' }));
    const panel = document.querySelector('[data-project-resource-panel]') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: strings.usageRefresh }));

    await waitFor(() => expect(usageRequests).toHaveLength(2));
    await waitFor(() => expect(panel.querySelector('[data-metric="cpu"]')).toHaveAttribute('data-metric-state', 'unavailable'));
    // The figure of generation 2 is gone rather than carried over as "last known".
    expect(within(panel).queryByRole('progressbar', { name: strings.usageCpu })).toBeNull();
    expect(within(panel).getAllByText(strings.usageUnavailable!).length).toBeGreaterThan(0);
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
    await screen.findAllByText(strings.state_running!);

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
    await screen.findAllByText(strings.state_stopped!);
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
    await screen.findAllByText(strings.state_stopped!);

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
    await screen.findAllByText(strings.state_running!);
    fireEvent.click(screen.getByRole('button', { name: 'analysis: Actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: strings.stopEnvironment }));

    const dialog = within(await screen.findByRole('alertdialog'));
    fireEvent.click(dialog.getByRole('button', { name: strings.stopEnvironment }));
    expect(await dialog.findByText('environment_busy')).toBeInTheDocument();
    expect(localStorage.getItem('elowen.environment-request:1:3')).not.toBeNull();
  });

  it('asks before stopping a running environment, and sends nothing until it is confirmed', async () => {
    mount();
    await screen.findAllByText(strings.state_running!);
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
