import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { CronJobsEditor } from '../../../modules/settings/CronJobsEditor';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { CronJob, DiscordChannelOption, BrainModelOption } from '../../../lib/types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const job = (over: Partial<CronJob>): CronJob =>
  ({ id: 'j1', name: 'digest', schedule: 'daily 06:00', prompt: 'do it', enabled: true, createdAt: '2026-01-01T00:00:00Z', ...over });

const CHANNELS: DiscordChannelOption[] = [
  { id: '100', name: 'general', type: 'channel' },
  { id: '200', name: 'bug-hunt', type: 'thread', parentName: 'general' },
];
const MODELS: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-sonnet-4-5', exec: 'brain', source: 'api-key', contextWindow: 200000, contextWindowSet: false },
];

async function mountWith(jobs: CronJob[]) {
  server.use(
    http.get('*/api/plugins/cronjob/jobs', () => HttpResponse.json(jobs)),
    http.get('*/api/plugins/discord/channels', () => HttpResponse.json(CHANNELS)),
    http.get('*/api/brain/models', () => HttpResponse.json(MODELS)),
    http.put('*/api/plugins/cronjob/jobs/:id', () => HttpResponse.json({ ok: true })),
  );
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><CronJobsEditor /></ToastProvider></Wrapper>);
  // Expand the job row so the channel/model fields render.
  fireEvent.click(await screen.findByText('digest'));
}

/** The trash icon of row `index`, then the dialog's confirm (both are labelled "Delete job"). */
const deleteRow = async (index: number) => {
  fireEvent.click(screen.getAllByRole('button', { name: 'Delete job' })[index]!);
  const buttons = await screen.findAllByRole('button', { name: 'Delete job' });
  fireEvent.click(buttons[buttons.length - 1]!);
};

/** The two SelectionSummary Manage buttons of an expanded job: [channel, model]. */
const manageButtons = () => screen.getAllByRole('button', { name: 'Manage' });

describe('CronJobsEditor destination channel', () => {
  it('picking a channel in the single-select modal replaces the destination', async () => {
    await mountWith([job({ notifyChannelId: '100' })]);
    fireEvent.click(manageButtons()[0]);
    // Text channels and threads land in their own groups; the guild default is pinned.
    expect(await screen.findByRole('heading', { name: 'Channels' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Threads' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '(default)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'general' })).toHaveAttribute('aria-pressed', 'true');
    // Single-select: picking the thread replaces the pick.
    fireEvent.click(screen.getByRole('button', { name: 'bug-hunt #general' }));
    expect(screen.getByRole('button', { name: 'general' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    // Modal closed; the summary chip (and the row-header badge) now show the new destination.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    expect(screen.getAllByText('bug-hunt').length).toBeGreaterThan(0);
  });

  it('a saved channel id the guild no longer lists stays visible and selected', async () => {
    await mountWith([job({ notifyChannelId: '999' })]);
    // The summary chip falls back to the raw id (as does the row-header badge).
    expect(screen.getAllByText('999').length).toBeGreaterThan(0);
    fireEvent.click(manageButtons()[0]);
    expect(await screen.findByRole('button', { name: '999' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('picking the pinned default clears the destination', async () => {
    await mountWith([job({ notifyChannelId: '100' })]);
    fireEvent.click(manageButtons()[0]);
    fireEvent.click(await screen.findByRole('button', { name: '(default)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    // No channel chip anymore — the summary shows the "—" default marker.
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

/** jobs.json is shared: the scheduler stamps runs into it and the brain's CronAdd tool writes it. A page
 *  that sent the whole list back would delete every job it had not seen — which is exactly how jobs went
 *  missing. So a write must name ONE job, and the rest of the list must be none of this page's business. */
describe('CronJobsEditor writes', () => {
  const mount = (jobs: CronJob[], writes: { id: string; body: unknown }[], deletes: string[]) => {
    server.use(
      http.get('*/api/plugins/cronjob/jobs', () => HttpResponse.json(jobs)),
      http.get('*/api/plugins/discord/channels', () => HttpResponse.json(CHANNELS)),
      http.get('*/api/brain/models', () => HttpResponse.json(MODELS)),
      http.put('*/api/plugins/cronjob/jobs/:id', async ({ request, params }) => {
        writes.push({ id: String(params.id), body: await request.json() });
        return HttpResponse.json({ ok: true });
      }),
      http.delete('*/api/plugins/cronjob/jobs/:id', ({ params }) => {
        deletes.push(String(params.id));
        return HttpResponse.json({ ok: true });
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><CronJobsEditor /></ToastProvider></Wrapper>);
  };

  it('saves only the job that was edited', async () => {
    const writes: { id: string; body: unknown }[] = [];
    mount([job({}), job({ id: 'j2', name: 'other' })], writes, []);
    fireEvent.click(await screen.findByText('digest'));
    fireEvent.change(screen.getByPlaceholderText('morning-digest'), { target: { value: 'renamed' } });
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 3000 });
    expect(writes[0]?.id).toBe('j1');
    expect(writes[0]?.body).toMatchObject({ id: 'j1', name: 'renamed' });
  });

  it('deletes a job by id and asks for nothing else', async () => {
    const deletes: string[] = [];
    mount([job({}), job({ id: 'j2', name: 'other' })], [], deletes);
    await screen.findByText('digest');
    await deleteRow(0);
    await waitFor(() => expect(deletes).toEqual(['j1']));
  });

  it('never writes away a job that appeared while the page was open — and then shows it', async () => {
    const writes: { id: string; body: unknown }[] = [];
    const jobs = [job({})];
    mount(jobs, writes, []);
    fireEvent.click(await screen.findByText('digest'));
    // Someone else adds a job to the shared file (the scheduler, CronAdd, a hand edit)…
    jobs.push(job({ id: 'j2', name: 'added-elsewhere' }));
    // …and this page saves the row it happened to be editing.
    fireEvent.change(screen.getByPlaceholderText('morning-digest'), { target: { value: 'renamed' } });
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 3000 });
    expect(writes.map((w) => w.id)).toEqual(['j1']); // its own row, and nothing else
    // The save refreshes the list from the server, so the new job simply appears.
    await waitFor(() => expect(screen.getByText('added-elsewhere')).toBeInTheDocument());
  });
});

/** A row owns one job's lifecycle — created, changed under it, deleted. Every case below is a way that
 *  lifecycle used to lose an edit or bring a deleted job back. */
describe('a cron job row', () => {
  const mount = (jobs: CronJob[], calls: { writes: { id: string; body: unknown }[]; deletes: string[] }, deleteStatus = 200) => {
    server.use(
      http.get('*/api/plugins/cronjob/jobs', () => HttpResponse.json(jobs)),
      http.get('*/api/plugins/discord/channels', () => HttpResponse.json(CHANNELS)),
      http.get('*/api/brain/models', () => HttpResponse.json(MODELS)),
      http.put('*/api/plugins/cronjob/jobs/:id', async ({ request, params }) => {
        const body = (await request.json()) as CronJob;
        calls.writes.push({ id: String(params.id), body });
        // The server now has it — the way it would on the next refetch.
        if (!jobs.some((j) => j.id === body.id)) jobs.push(body);
        return HttpResponse.json({ ok: true });
      }),
      http.delete('*/api/plugins/cronjob/jobs/:id', ({ params }) => {
        calls.deletes.push(String(params.id));
        if (deleteStatus !== 200) return HttpResponse.json({ error: 'nope' }, { status: deleteStatus });
        const at = jobs.findIndex((j) => j.id === String(params.id));
        if (at >= 0) jobs.splice(at, 1);
        return HttpResponse.json({ ok: true });
      }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><CronJobsEditor /></ToastProvider></Wrapper>);
  };
  /** The name input / prompt textarea of the Nth expanded row. */
  const nameBox = (row = 0) => screen.getAllByPlaceholderText('morning-digest')[row]!;
  const promptBox = (row = 0) => document.querySelectorAll<HTMLTextAreaElement>('textarea[rows="5"]')[row]!;

  // A new row is invalid until it has both a name and a prompt, so the edit that finally makes it valid is
  // the one that must be saved — and it was the one being eaten.
  it('saves a newly added job once the user has filled it in', async () => {
    const calls = { writes: [] as { id: string; body: unknown }[], deletes: [] as string[] };
    mount([], calls);
    fireEvent.click(await screen.findByText('Add job'));
    fireEvent.change(nameBox(), { target: { value: 'nightly' } });
    fireEvent.change(promptBox(), { target: { value: 'Summarize the day.' } });
    await waitFor(() => expect(calls.writes).toHaveLength(1), { timeout: 3000 });
    expect(calls.writes[0]?.body).toMatchObject({ name: 'nightly', prompt: 'Summarize the day.' });
  });

  it('deletes a brand-new job that has already reached the server, so it cannot come back', async () => {
    const calls = { writes: [] as { id: string; body: unknown }[], deletes: [] as string[] };
    mount([job({})], calls);
    await screen.findByText('digest');
    fireEvent.click(screen.getByText('Add job'));
    fireEvent.change(nameBox(), { target: { value: 'oops' } }); // the added row is the only expanded one
    fireEvent.change(promptBox(), { target: { value: 'created by mistake' } });
    await waitFor(() => expect(calls.writes).toHaveLength(1), { timeout: 3000 }); // it reached the server…
    await deleteRow(1);
    // …so it must be deleted there too, or the refetch brings it back and it starts running on schedule.
    await waitFor(() => expect(calls.deletes).toEqual([calls.writes[0]?.id]));
    await waitFor(() => expect(screen.queryByDisplayValue('oops')).toBeNull());
  });

  it('keeps saving a job whose delete failed, instead of silently dropping every later edit', async () => {
    const calls = { writes: [] as { id: string; body: unknown }[], deletes: [] as string[] };
    mount([job({})], calls, 500);
    fireEvent.click(await screen.findByText('digest'));
    await deleteRow(0);
    await waitFor(() => expect(calls.deletes).toEqual(['j1']));
    // The job is still there. An edit to it must still be persisted — not swallowed under a "saved" chip.
    fireEvent.change(nameBox(), { target: { value: 'still here' } });
    await waitFor(() => expect(calls.writes).toHaveLength(1), { timeout: 3000 });
    expect(calls.writes[0]?.body).toMatchObject({ id: 'j1', name: 'still here' });
  });

  it('adopts a job the server changed under it, rather than overwriting it from a stale draft', async () => {
    const calls = { writes: [] as { id: string; body: unknown }[], deletes: [] as string[] };
    const jobs = [job({}), job({ id: 'j2', name: 'other' })];
    mount(jobs, calls);
    fireEvent.click(await screen.findByText('digest')); // expand the row we are NOT going to touch
    fireEvent.click(screen.getByText('other'));
    // The brain's cron tooling rewrites the first job's prompt while the page sits open…
    jobs[0] = job({ prompt: 'Rewritten by the agent.' });
    // …and an edit to the OTHER row refreshes the list.
    fireEvent.change(nameBox(1), { target: { value: 'other renamed' } });
    await waitFor(() => expect(calls.writes.map((w) => w.id)).toEqual(['j2']), { timeout: 3000 });
    // The untouched row shows what the server actually holds — the next save cannot revert it.
    await waitFor(() => expect(screen.getByDisplayValue('Rewritten by the agent.')).toBeInTheDocument());
  });
});

describe('CronJobsEditor model', () => {
  it('groups the catalog by provider with a pinned Default and picking a model updates the chip', async () => {
    await mountWith([job({})]);
    fireEvent.click(manageButtons()[1]);
    const heading = await screen.findByRole('heading', { name: 'Anthropic' });
    // The provider group header carries its brand logo, and each model row its own model icon.
    expect(heading.querySelector('img')).toBeTruthy();
    const modelRow = screen.getByRole('button', { name: 'claude-sonnet-4-5' });
    expect(modelRow.querySelector('img')).toBeTruthy();
    // No model saved → the pinned Default row is the current pick.
    expect(screen.getByRole('button', { name: 'default' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(modelRow);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument();
  });

  it('shows the saved model as the selected row when reopening', async () => {
    await mountWith([job({ model: { provider: 'anthropic', model: 'claude-sonnet-4-5' } })]);
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument(); // summary chip
    fireEvent.click(manageButtons()[1]);
    expect(await screen.findByRole('button', { name: 'claude-sonnet-4-5' })).toHaveAttribute('aria-pressed', 'true');
  });
});
