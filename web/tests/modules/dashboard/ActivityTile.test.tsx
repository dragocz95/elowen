import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { ActivityTile } from '../../../modules/dashboard/ActivityTile';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { ActivityEvent } from '../../../lib/types';

// The team feed ("Dění") answers WHO worked and FROM WHERE. A row is about a person, so it reads
// differently from the task timeline rows that share the same table and the same tile.
const row = (over: Partial<ActivityEvent>): ActivityEvent => ({
  id: 1, ts: '2026-08-22 20:00:00', type: 'turn', target: 'brain-1', detail: 'claude-opus-5',
  project_id: null, label: '', actor_user_id: 1, actor_label: 'Filip Džudža', surface: 'web',
  count: 1, last_ts: '2026-08-22 20:05:00', ...over,
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

function mount(rows: ActivityEvent[], working: { userId: number; label: string }[] = []) {
  server.use(http.get('*/api/activity', () => HttpResponse.json(rows)));
  server.use(http.get('*/api/activity/presence', () => HttpResponse.json(working)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ActivityTile /></Wrapper>);
}

describe('ActivityTile — team feed rows', () => {
  it('leads with the person and names the surface they worked from', async () => {
    mount([row({})]);
    expect(await screen.findByText('Filip Džudža')).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${en.dashboard.ev.turn}.*${en.dashboard.surfaces.web}`))).toBeInTheDocument();
  });

  it('shows how many identical events a row folds', async () => {
    mount([row({ count: 7, surface: 'discord' })]);
    expect(await screen.findByText(/×7/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.dashboard.surfaces.discord))).toBeInTheDocument();
  });

  it('says "someone" rather than leaving the row anonymous when the account is gone', async () => {
    mount([row({ actor_label: '', actor_user_id: 9 })]);
    expect(await screen.findByText(en.dashboard.ev.someone)).toBeInTheDocument();
  });

  it('never renders the conversation id of a team-feed row', async () => {
    mount([row({ target: 'brain-1-secret-session' })]);
    await screen.findByText('Filip Džudža');
    // The feed is instance-wide; a session id is an internal handle, not something the team needs.
    expect(screen.queryByText(/brain-1-secret-session/)).not.toBeInTheDocument();
  });

  it('still renders an ordinary timeline row in its own shape', async () => {
    mount([row({ type: 'task', detail: 'open', label: 'Ship the thing', actor_label: '' })]);
    expect(await screen.findByText(en.dashboard.ev.taskOpen)).toBeInTheDocument();
    expect(screen.getByText('Ship the thing')).toBeInTheDocument();
  });
});

// Presence is the daemon's live view of RUNNING TURNS -- not "typing", which no platform reports.
describe('ActivityTile — presence line', () => {
  it('names who is working right now', async () => {
    mount([row({})], [{ userId: 1, label: 'Filip Džudža' }, { userId: 2, label: 'Michal' }]);
    expect(await screen.findByText(`${en.dashboard.workingNow}: Filip Džudža, Michal`)).toBeInTheDocument();
  });

  it('falls back to the plain live badge when nobody is working', async () => {
    mount([row({})], []);
    expect(await screen.findByText(en.dashboard.live)).toBeInTheDocument();
    // It must not claim activity that is not happening.
    expect(screen.queryByText(new RegExp(en.dashboard.workingNow))).not.toBeInTheDocument();
  });
});
