import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { HeroCosmos } from '../../../modules/dashboard/HeroCosmos';
import { createWrapper } from '../../test-utils';
import { EffectsProvider } from '../../../lib/useEffects';

const NOW = new Date('2026-06-30T12:00:00Z').getTime();

// The instance these tests describe runs both plugins the cosmos reads: agents (decisions/agents pods)
// and cronjob (the next-run pod). Each pod is asserted to disappear with its own plugin below.
const AGENTS_UI = [
  { name: 'agents', title: 'Agents', nav: [{ route: 'sessions', label: 'Sessions' }], settings: [] },
  { name: 'cronjob', title: 'Cron', nav: [], settings: [{ id: 'jobs', label: 'Cron' }] },
];

function server(opts: { asks?: unknown[]; jobs?: unknown[]; pluginUi?: unknown[] } = {}) {
  return setupServer(
    http.get('*/api/plugins/ui', () => HttpResponse.json(opts.pluginUi ?? AGENTS_UI)),
    http.get('*/api/health', () => HttpResponse.json({ ok: true, version: '0.26.0' })),
    http.get('*/api/tasks', () => HttpResponse.json([])),
    http.get('*/api/tasks/deps', () => HttpResponse.json([])),
    http.get('*/api/sessions', () => HttpResponse.json([{ name: 'elowen-Iris', role: 'agent', agent: 'iris' }])),
    http.get('*/api/auth/me', () => HttpResponse.json({ user: { is_admin: false } })),
    http.get('*/api/asks/pending', () => HttpResponse.json(opts.asks ?? [])),
    http.get('*/api/activity', () => HttpResponse.json([])),
    http.get('*/api/usage/by-model', () => HttpResponse.json([
      { exec: 'sonnet', usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500, costUsd: 3.5 } },
    ])),
    http.get('*/api/usage/by-day', () => HttpResponse.json([{ day: '2026-06-30', tokens: 1500, cost: 3.5 }])),
    http.get('*/api/plugins/cronjob/jobs', () => HttpResponse.json(opts.jobs ?? [])),
  );
}

function renderCosmos() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper>
      <EffectsProvider>
        <HeroCosmos now={NOW} state="working" presenceLabel="Elowen: Working" />
      </EffectsProvider>
    </Wrapper>,
  );
}

describe('HeroCosmos', () => {
  const srv = server();
  beforeAll(() => srv.listen({ onUnhandledRequest })); afterEach(() => srv.resetHandlers()); afterAll(() => srv.close());

  it('renders the mascot and four signal pods as links in stack mode', async () => {
    renderCosmos();

    // jsdom has no layout (clientWidth 0), so the orbit never engages and the stack DOM carries everything.
    expect(screen.getByTestId('hero-cosmos').dataset.mode).toBe('stack');
    expect(screen.getByRole('img', { name: 'Elowen: Working' })).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: 'Attention' });
    expect(await within(nav).findByText('Decisions waiting')).toBeTruthy();
    expect(within(nav).getByText('Agents active')).toBeTruthy();
    expect(within(nav).getByText('Next run')).toBeTruthy();
    expect(within(nav).getByText('This month')).toBeTruthy();
    const hrefs = within(nav).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/p/agents/escalations', '/p/agents/sessions', '/p/cronjob/settings/jobs', '/stats']);
  });

  it('tones the decisions pod as an alert while asks are pending', async () => {
    srv.use(http.get('*/api/asks/pending', () => HttpResponse.json([{ id: 1 }, { id: 2 }])));
    renderCosmos();

    const nav = screen.getByRole('navigation', { name: 'Attention' });
    const decisions = await within(nav).findByRole('link', { name: /Decisions waiting 2/ });
    expect(decisions.className).toContain('hero-cosmos__pod--alert');
  });

  it('hides the decisions + agents pods when the agents plugin contributes no UI', async () => {
    srv.use(http.get('*/api/plugins/ui', () => HttpResponse.json(AGENTS_UI.filter((p) => p.name !== 'agents'))));
    renderCosmos();

    const nav = screen.getByRole('navigation', { name: 'Attention' });
    // The remaining pods still render — the cosmos never links into the missing plugin's pages.
    expect(await within(nav).findByText('Next run')).toBeTruthy();
    expect(within(nav).getByText('This month')).toBeTruthy();
    expect(within(nav).queryByText('Decisions waiting')).toBeNull();
    expect(within(nav).queryByText('Agents active')).toBeNull();
    const hrefs = within(nav).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/p/cronjob/settings/jobs', '/stats']);
  });

  it('drops the next-run pod without the cron plugin instead of reporting an empty schedule', async () => {
    // Left in, the pod would read "No scheduled jobs" — the same thing it says for an instance that HAS a
    // scheduler and nothing in it — while its request 503s and its link led into a plugin that is gone.
    srv.use(http.get('*/api/plugins/ui', () => HttpResponse.json(AGENTS_UI.filter((p) => p.name !== 'cronjob'))));
    renderCosmos();

    const nav = screen.getByRole('navigation', { name: 'Attention' });
    expect(await within(nav).findByText('Agents active')).toBeTruthy();
    expect(within(nav).queryByText('Next run')).toBeNull();
    expect(within(nav).queryByText('No scheduled jobs')).toBeNull();
    const hrefs = within(nav).getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual(['/p/agents/escalations', '/p/agents/sessions', '/stats']);
  });

  it('reports the quiet state without alerts or scheduled jobs', async () => {
    renderCosmos();

    const nav = screen.getByRole('navigation', { name: 'Attention' });
    expect(await within(nav).findByText('All handled')).toBeTruthy();
    expect(within(nav).getByText('No scheduled jobs')).toBeTruthy();
    const decisions = within(nav).getByRole('link', { name: /Decisions waiting/ });
    expect(decisions.className).not.toContain('hero-cosmos__pod--alert');
  });
});
