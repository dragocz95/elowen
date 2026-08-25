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
  project_id: null, label: '', actor_user_id: 1, actor_label: 'Filip Džudža',
  actor_username: 'filip', actor_avatar: null, surface: 'web',
  count: 1, last_ts: '2026-08-22 20:05:00', ...over,
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

function mount(rows: ActivityEvent[], working: { userId: number; label: string; working: boolean }[] = []) {
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

  it('says what the turn ran instead of only where it ran', async () => {
    // The tools ARE the content of the row: "worked · web" is true and says nothing about the work.
    mount([row({ tools: [{ name: 'Bash', count: 3 }, { name: 'Read', count: 1 }] })]);

    expect(await screen.findByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('×3')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    // With tools present the surface line is replaced rather than stacked below it.
    expect(screen.queryByText(new RegExp(`${en.dashboard.ev.turn}.*${en.dashboard.surfaces.web}`))).not.toBeInTheDocument();
  });

  it('falls back to the surface when the turn has no tools to show', async () => {
    // Tools age out of the daemon's read window, and older rows never had them. The row must still speak.
    mount([row({ tools: [] })]);
    expect(await screen.findByText(new RegExp(`${en.dashboard.ev.turn}.*${en.dashboard.surfaces.web}`))).toBeInTheDocument();
  });

  it('drops the MCP namespace from a tool name but keeps it in the title', async () => {
    mount([row({ tools: [{ name: 'mcp__chrome_devtools__take_screenshot', count: 1 }] })]);

    expect(await screen.findByText('take_screenshot')).toBeInTheDocument();
    expect(screen.getByTitle('mcp__chrome_devtools__take_screenshot')).toBeInTheDocument();
  });

  it('caps the pills and counts the rest rather than wrapping a long list', async () => {
    mount([row({
      tools: [
        { name: 'Read', count: 9 }, { name: 'Edit', count: 8 }, { name: 'Bash', count: 7 },
        { name: 'Grep', count: 6 }, { name: 'Write', count: 5 }, { name: 'Search', count: 4 },
      ],
    })]);

    expect(await screen.findByText('Read')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    // The overflow keeps the names reachable without drawing them.
    expect(screen.queryByText('Search')).not.toBeInTheDocument();
    expect(screen.getByTitle('Write, Search')).toBeInTheDocument();
  });

  it('says "someone" rather than leaving the row anonymous when the account is gone', async () => {
    mount([row({ actor_label: '', actor_user_id: 9 })]);
    expect(await screen.findByText(en.dashboard.ev.someone)).toBeInTheDocument();
  });

  /** A feed row is about a person, so it leads with their face. The row carried only a name until the
   *  JOIN started resolving the avatar too. */
  it('draws the face of whoever the row is about', async () => {
    server.use(http.get('*/api/users/1/avatar/url', () => HttpResponse.json({ url: '/api/users/1/avatar?sig=x' })));
    mount([row({ actor_avatar: 'filip.png' })]);
    const face = await screen.findByRole('img', { name: 'Filip Džudža' });
    expect(face).toHaveAttribute('src', expect.stringContaining('/users/1/avatar'));
  });

  it('leaves an unattributable row faceless rather than inventing a monogram', async () => {
    mount([row({ actor_user_id: null, actor_label: '', actor_username: null })]);
    expect(await screen.findByText(en.dashboard.ev.someone)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
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
    mount([row({})], [{ userId: 1, label: 'Filip Džudža', working: true }, { userId: 2, label: 'Michal', working: true }]);
    expect(await screen.findByText(`${en.dashboard.workingNow}: Filip Džudža, Michal`)).toBeInTheDocument();
  });

  it('falls back to the plain live badge when nobody is working', async () => {
    mount([row({})], []);
    expect(await screen.findByText(en.dashboard.live)).toBeInTheDocument();
    // It must not claim activity that is not happening.
    expect(screen.queryByText(new RegExp(en.dashboard.workingNow))).not.toBeInTheDocument();
  });

  // Presence also carries people who were merely seen today, for the pulse rail above. This line is
  // about NOW, so someone who is not mid-turn must not be announced as working.
  it('does not announce somebody who was only seen earlier', async () => {
    mount([row({})], [{ userId: 2, label: 'Michal', working: false }]);
    expect(await screen.findByText(en.dashboard.live)).toBeInTheDocument();
    expect(screen.queryByText(/Michal/)).not.toBeInTheDocument();
  });
});
