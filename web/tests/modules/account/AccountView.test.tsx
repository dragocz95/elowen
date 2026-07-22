import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';

// Monaco is browser-only and never mounts under jsdom; stub the personality body editor.
vi.mock('../../../modules/projects/editor/monacoLoader', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="personality-body" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  MonacoDiffEditor: () => null,
}));
import { AccountView } from '../../../modules/account/AccountView';
import { ToastProvider } from '../../../components/ui/Toast';
import { UiScaleProvider } from '../../../lib/useUiScale';
import { EffectsProvider } from '../../../lib/useEffects';
import { createWrapper } from '../../test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => { server.resetHandlers(); localStorage.clear(); }); afterAll(() => server.close());

const meUser = (over: Record<string, unknown> = {}) => ({ id: 2, username: 'bob', name: '', email: '', avatar: '', default_exec: '', is_admin: false, allowed_execs: ['sonnet'], created_at: '2026-01-01', ...over });

describe('AccountView', () => {
  it('uses the shared control deck with the approved Account section order and one mascot', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ name: 'Bob' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ model: '', modelProvider: '', discordUserId: '', whatsappNumber: '' })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    const rail = screen.getByRole('radiogroup', { name: 'Account sections' });
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual([
      'Account', 'Security', 'Notifications', 'Personality', 'Memory', 'Terminal', 'Elowen AI',
    ]);
    expect(screen.getAllByRole('img', { name: 'Elowen' })).toHaveLength(1);
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('@bob'));
  });

  it('shows the user identity, and saves a default worker picked in the manage modal', async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.patch('*/api/auth/me', async ({ request }) => { patched = await request.json() as Record<string, unknown>; return HttpResponse.json(meUser({ default_exec: 'sonnet' })); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    expect(await screen.findByText('@bob')).toBeTruthy();
    // The default model is the first practical profile setting, not hidden in the Elowen AI section.
    // Open the worker summary and pick the single allowed model.
    fireEvent.click(screen.getByRole('button', { name: 'Manage: Default worker' }));
    // The modal groups by engine: a "Claude Code" header carrying the provider logo, and a model row.
    const heading = await screen.findByRole('heading', { name: 'Claude Code' });
    expect(heading.querySelector('img')).toBeTruthy(); // group logo renders
    const row = screen.getByRole('button', { name: /Claude Sonnet/ });
    expect(row.querySelector('img')).toBeTruthy(); // per-row model icon renders
    fireEvent.click(row); // single-select: replaces the pick
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(patched?.default_exec).toBe('sonnet'));
  });

  it('falls back to the profile section when a removed section id is persisted', async () => {
    localStorage.setItem('elowen.account.section', 'prompts'); // the Prompts tab no longer exists
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    // The stale value fails the allowed-list guard, so the default (profile) section renders.
    expect(await screen.findByText('@bob')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Prompts' })).toBeNull();
  });

  it('retains a visited section\'s local controls while another account panel is active', async () => {
    localStorage.setItem('elowen.account.section', 'profile');
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], autopilot: {}, providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({
        model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '',
        autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'concise', personalityBody: '',
        discordUserId: '', whatsappNumber: '', autoRecall: true, autoSave: true,
      })),
      http.patch('*/api/auth/me/cli-settings', () => HttpResponse.json({})),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    await screen.findByText('@bob');
    fireEvent.click(screen.getByRole('radio', { name: 'Personality' }));
    // Wait for the personality form to seed ('Concise' pill pressed) before changing a local control.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Concise' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Friendly' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Friendly' })).toHaveAttribute('aria-pressed', 'true'));

    // Navigate away: the panel is kept mounted but hidden (React <Activity>), so it drops out of the
    // accessibility tree — findable only with hidden:true, and not visible.
    fireEvent.click(screen.getByRole('radio', { name: 'Account' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Friendly', hidden: true })).not.toBeVisible());
    fireEvent.click(screen.getByRole('radio', { name: 'Personality' }));
    // The visited panel stayed mounted, so the local pick survives navigating away and back. The reveal
    // from <Activity> hidden→visible is deferred, so wait for it rather than asserting synchronously.
    await waitFor(() => {
      const friendly = screen.getByRole('button', { name: 'Friendly' });
      expect(friendly).toHaveAttribute('aria-pressed', 'true');
      expect(friendly).toBeVisible();
    });
  });
});
