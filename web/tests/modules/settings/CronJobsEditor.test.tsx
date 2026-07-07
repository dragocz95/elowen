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
    http.put('*/api/plugins/cronjob/jobs', () => HttpResponse.json({ ok: true })),
  );
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><CronJobsEditor /></ToastProvider></Wrapper>);
  // Expand the job row so the channel/model fields render.
  fireEvent.click(await screen.findByText('digest'));
}

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

describe('CronJobsEditor model', () => {
  it('groups the catalog by provider with a pinned Default and picking a model updates the chip', async () => {
    await mountWith([job({})]);
    fireEvent.click(manageButtons()[1]);
    expect(await screen.findByRole('heading', { name: 'Anthropic' })).toBeInTheDocument();
    // No model saved → the pinned Default row is the current pick.
    expect(screen.getByRole('button', { name: 'default' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'claude-sonnet-4-5' }));
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
