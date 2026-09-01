import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
vi.mock('next/navigation', () => ({ usePathname: () => '/settings', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }) }));
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import SettingsPage from '../../app/settings/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';
import { en } from '../../lib/i18n/dictionaries/en';
import { formatBytes } from '../../lib/format';

let putBody: unknown = null;
let putBodies: unknown[] = [];
const config = {
  allowedExecs: ['elowen:anthropic::opus'], customModels: [], providers: {},
  defaults: { exec: 'elowen:anthropic::opus', autonomy: 'L1', maxSessions: 1 },
  security: { tokenTtlDays: 30 }, sessionRetention: { enabled: false, days: 90 },
};
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json(config)),
  http.get('*/api/brain/models', () => HttpResponse.json([
    { provider: 'anthropic', providerLabel: 'Anthropic', model: 'Claude Opus', exec: 'elowen:anthropic::opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
  ])),
  http.get('*/api/system', () => HttpResponse.json({
    version: '0.26.0', latest: '0.26.0', updateAvailable: false, autoUpdate: false, lastUpdatedAt: '2026-07-11T12:00:00.000Z',
    diagnostics: { cpuPercent: 12, memoryUsedBytes: 3_200_000_000, memoryTotalBytes: 16_000_000_000, uptimeSeconds: 1_098_000 },
  })),
  http.get('*/api/system/skills', () => HttpResponse.json({ skills: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin', name: 'Admin', is_admin: true } })),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
  http.get('*/api/brain/debug/sessions', () => HttpResponse.json({ items: [], nextCursor: null, captureStartedAt: Date.UTC(2026, 7, 1, 10, 0, 0) })),
  http.get('*/api/system/logs', () => HttpResponse.json({
    dir: '/var/log/elowen',
    files: [
      { name: 'daemon-2026-08-29.log', source: 'daemon', bytes: 1_000, modifiedAt: 2 },
      { name: 'web-2026-08-29.log', source: 'web', bytes: 2_000, modifiedAt: 1 },
    ],
  })),
  http.put('*/api/config', async ({ request }) => {
    putBody = await request.json();
    putBodies.push(putBody);
    return HttpResponse.json(config);
  }),
);
beforeEach(() => {
  putBody = null;
  putBodies = [];
  localStorage.setItem('elowen.settings.category', 'models');
});
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); localStorage.clear(); window.history.replaceState(null, '', '/settings'); });
afterAll(() => server.close());

describe('SettingsPage', () => {
  it('matches the reference section order and renders real System diagnostics', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
    const rail = screen.getByRole('radiogroup', { name: 'Settings sections' });
    expect(container.querySelector('.workspace-shell')).toHaveAttribute('data-section-layout', 'sidebar');
    expect(rail).toHaveAttribute('data-variant', 'menu');
    expect(rail).toHaveAttribute('aria-orientation', 'vertical');
    expect(rail.querySelectorAll('.segmented__option > svg')).toHaveLength(7);
    expect(screen.queryByRole('combobox', { name: 'Settings sections' })).toBeNull();
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual([
      'System', 'Elowen AI', 'Models', 'Plugins', 'Memory', 'Recap', 'Data',
    ]);
    expect(screen.getByText('System diagnostics')).toBeInTheDocument();
    // The dials are a lazy chunk, so the reading lands a tick after the section itself. Spaced before
    // the percent sign like every other figure in the app.
    expect(await screen.findByText('12 %')).toBeInTheDocument();
  });

  it('offers conversation diagnostics without capture controls in Data', async () => {
    localStorage.setItem('elowen.settings.category', 'data');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Conversation diagnostics')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open diagnostics' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /capture/i })).not.toBeInTheDocument();
  });

  it('treats a missing model allowlist as empty instead of crashing', async () => {
    server.use(http.get('*/api/config', () => HttpResponse.json({ ...config, allowedExecs: undefined })));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeInTheDocument();
    expect(screen.getByLabelText('Claude Opus')).not.toBeChecked();
  });

  it('renders the embedded model catalog without removed CLI-provider controls', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByLabelText('Claude Opus')).toBeChecked();
    expect(screen.queryByText('Claude Code')).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add model' })).toBeNull();
  });

  it('auto-saves an embedded model allowlist change', async () => {
    putBody = null;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    const toggle = await screen.findByLabelText('Claude Opus');
    fireEvent.click(toggle);
    await waitFor(() => expect((putBody as { allowedExecs: string[] }).allowedExecs).not.toContain('elowen:anthropic::opus'));
  });

  it('toggles conversation auto-cleanup and persists sessionRetention', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });
    putBody = null;
    fireEvent.click(screen.getByRole('switch', { name: en.settings.retention.label }));
    await waitFor(() => expect((putBody as { sessionRetention: { enabled: boolean } }).sessionRetention).toEqual({ enabled: true }));
  });

  it('keeps the policy rows compact and edits token TTL through canonical presets', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.settings.tokenTtlEdit })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.settings.retention.edit })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: en.settings.tokenTtlEdit }));
    const ttlDialog = screen.getByRole('dialog', { name: en.settings.tokenTtl });
    expect(within(ttlDialog).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '7 days', '30 days', '90 days', '365 days', en.settings.daysPolicy.custom,
    ]);
    fireEvent.click(within(ttlDialog).getByRole('radio', { name: '365 days' }));
    await waitFor(() => expect(putBodies).toContainEqual(expect.objectContaining({ security: { tokenTtlDays: 365 } })));
  });

  it('saves retention presets and custom values from the shared days editor', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    fireEvent.click(screen.getByRole('button', { name: en.settings.retention.edit }));
    const retentionDialog = screen.getByRole('dialog', { name: en.settings.retention.label });
    expect(within(retentionDialog).getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '7 days', '10 days', '30 days', '90 days', en.settings.daysPolicy.custom,
    ]);
    fireEvent.click(within(retentionDialog).getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(putBodies).toContainEqual({ sessionRetention: { days: 30 } }));

    fireEvent.click(screen.getByRole('radio', { name: en.settings.daysPolicy.custom }));
    const custom = screen.getByRole('textbox', { name: `Custom duration for ${en.settings.retention.olderThan}` });
    expect(custom).toHaveAccessibleDescription(en.settings.daysPolicy.days);
    fireEvent.change(custom, { target: { value: '45' } });
    fireEvent.blur(custom);
    await waitFor(() => expect(putBodies).toContainEqual({ sessionRetention: { days: 45 } }));

    fireEvent.change(custom, { target: { value: '60' } });
    fireEvent.keyDown(custom, { key: 'Enter' });
    await waitFor(() => expect(putBodies).toContainEqual({ sessionRetention: { days: 60 } }));
  });

  it('restores an invalid custom day value without saving it', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });
    fireEvent.click(screen.getByRole('button', { name: en.settings.tokenTtlEdit }));
    fireEvent.click(screen.getByRole('radio', { name: en.settings.daysPolicy.custom }));
    const custom = screen.getByRole('textbox', { name: `Custom duration for ${en.settings.tokenTtl}` });

    fireEvent.change(custom, { target: { value: '45' } });
    fireEvent.blur(custom);
    await waitFor(() => expect(putBodies).toContainEqual(expect.objectContaining({ security: { tokenTtlDays: 45 } })));
    const callsAfterValid = putBodies.length;

    fireEvent.change(custom, { target: { value: '' } });
    fireEvent.blur(custom);
    expect(custom).toHaveValue('45');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(putBodies).toHaveLength(callsAfterValid);
  });

  it('serializes retention saves, restores a failure and allows retry', async () => {
    let attempts = 0;
    let failFirst: (() => void) | undefined;
    server.use(http.put('*/api/config', async ({ request }) => {
      const body = await request.json() as { sessionRetention?: { days?: number } };
      if (body.sessionRetention?.days !== undefined) attempts += 1;
      if (attempts === 1) {
        return new Promise<Response>((resolve) => {
          failFirst = () => resolve(HttpResponse.json({ error: 'save failed' }, { status: 500 }));
        });
      }
      return HttpResponse.json({ ...config, sessionRetention: { enabled: false, days: body.sessionRetention?.days ?? 90 } });
    }));
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });
    fireEvent.click(screen.getByRole('button', { name: en.settings.retention.edit }));
    const dialog = screen.getByRole('dialog', { name: en.settings.retention.label });

    fireEvent.click(within(dialog).getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: '7 days' })).toBeDisabled());
    fireEvent.click(within(dialog).getByRole('radio', { name: '7 days' }));
    expect(attempts).toBe(1);

    await act(async () => { failFirst?.(); });
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: '90 days' })).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(within(dialog).getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(attempts).toBe(2));
  });

  it('falls back to System for a stale moved-section deep-link', async () => {
    localStorage.setItem('elowen.settings.category', 'retired-section');
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    expect(await screen.findByRole('heading', { level: 1, name: 'System' })).toBeInTheDocument();
  });

  /** Both restart buttons must be DIRECT children of the hero's action row. The rule that stops them
   *  alternating right- then left-aligned down a narrow column — `.workspace-hero__actions >
   *  :not(.workspace-hero__status) { flex: 1 1 10rem }` — is a child selector, so wrapping the pair in a
   *  layout div would quietly bring the zig-zag back with nothing else on the page changing. */
  it('hangs both hero restart actions directly off the hero action row', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    const actions = container.querySelector('.workspace-hero__actions');
    expect(actions).not.toBeNull();
    for (const label of [en.settings.restartDaemon, en.settings.restartWeb]) {
      expect(screen.getByRole('button', { name: label }).parentElement).toBe(actions);
    }
  });

  /** The page's controls live in ONE row, below the section navigation — not promoted above the title and
   *  not re-declared per section. The row is mounted on every section because it carries the portal slot,
   *  so a section with nothing to put in it must leave the row genuinely empty rather than draw a band. */
  it('puts the model search in the canonical toolbar row', async () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByLabelText('Claude Opus');

    const search = screen.getByLabelText(en.settings.modelSearchPlaceholder);
    expect(container.querySelector('.page-toolbar__search')).toContainElement(search);
    // The row is under the section navigation, and the hero above it is not a control surface.
    expect(container.querySelector('.workspace-hero')!.contains(search)).toBe(false);
  });

  it('hangs the Elowen AI cross-link off the toolbar actions', async () => {
    localStorage.setItem('elowen.settings.category', 'brain');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);

    const link = await screen.findByRole('button', { name: en.settings.brainModelsLink });
    expect(container.querySelector('.page-toolbar__actions')).toContainElement(link);

    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Models' })).toBeInTheDocument();
  });

  /** The canonical anatomy is heading → metric rail → toolbar, on EVERY page and every section of one.
   *  The deck used to open the rail for System alone, so five of the six settings sections went straight
   *  from the title to their records and read as a different kind of page than the registers. */
  it('opens every settings section with a metric rail of its own', async () => {
    for (const [cat, heading] of [
      ['system', 'System'], ['brain', 'Elowen AI'], ['models', 'Models'],
      ['plugins', 'Plugins'], ['memory', 'Memory'], ['data', 'Data'],
    ] as const) {
      localStorage.setItem('elowen.settings.category', cat);
      const { wrapper: Wrapper } = createWrapper();
      const { container, unmount } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
      await screen.findByRole('heading', { level: 1, name: heading });

      const rail = container.querySelector('[data-testid="workspace-hero-metrics"]');
      expect(rail, `${cat} opens with no metric rail`).not.toBeNull();
      expect(rail!.querySelectorAll('.workspace-metric').length, `${cat} rail carries no figures`).toBeGreaterThan(0);
      unmount();
    }
  });

  it('keeps the rail between the heading and the one toolbar row', async () => {
    localStorage.setItem('elowen.settings.category', 'models');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'Models' });

    const shell = container.querySelector('.workspace-shell')!;
    const anatomy = Array.from(shell.querySelectorAll('h1, [data-testid="workspace-hero-metrics"], .page-toolbar__row'));
    expect(anatomy).toHaveLength(3);
    expect(anatomy[0]!.tagName).toBe('H1');
    expect(anatomy[1]).toBe(shell.querySelector('[data-testid="workspace-hero-metrics"]'));
    expect(anatomy[2]!.className).toContain('page-toolbar__row');
  });

  /** A rail is only worth the strip it occupies if the figures are the section's own. Data is asserted in
   *  full — it reads four different sources (the log summary, its byte total, the runtime capture flag and
   *  the retention setting) and none of them is the System instance state the rail used to show
   *  everywhere. */
  it('fills a non-system rail from that section\'s own data', async () => {
    localStorage.setItem('elowen.settings.category', 'data');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'Data' });

    const rail = container.querySelector('[data-testid="workspace-hero-metrics"]')!;
    await waitFor(() => expect(rail.textContent).toContain(formatBytes(3_000)));
    const readings = Array.from(rail.querySelectorAll('.workspace-metric')).map((metric) => [
      metric.querySelector('.workspace-metric__label')!.textContent,
      metric.querySelector('.workspace-metric__value')!.textContent,
    ]);
    expect(readings).toEqual([
      [en.settings.metric.logFiles, '2'],
      [en.settings.metric.logVolume, formatBytes(3_000)],
      [en.settings.metric.requestCapture, en.settings.on],
      [en.settings.metric.conversationCleanup, en.settings.off],
    ]);
  });

  it('leaves the toolbar row empty for a section with no page-level controls', async () => {
    localStorage.setItem('elowen.settings.category', 'system');
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><ToastProvider><SettingsPage /></ToastProvider></Wrapper>);
    await screen.findByRole('heading', { level: 1, name: 'System' });

    const row = container.querySelector('.page-toolbar__row');
    expect(row).not.toBeNull();
    // Only the portal slot, and nothing in it — which is what the stylesheet collapses the row on.
    expect(Array.from(row!.children).map((node) => node.className)).toEqual(['page-toolbar__slot']);
    expect(row!.querySelector('.page-toolbar__slot')!.children).toHaveLength(0);
  });
});
