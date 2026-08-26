import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';

// Monaco is browser-only and never mounts under jsdom; stub the personality body editor.
vi.mock('../../../lib/monaco/monacoLoader', () => ({
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
beforeAll(() => server.listen({ onUnhandledRequest }));
beforeEach(() => server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([]))));
afterEach(() => { server.resetHandlers(); localStorage.clear(); });
afterAll(() => server.close());

const meUser = (over: Record<string, unknown> = {}) => ({ id: 2, username: 'bob', name: '', email: '', avatar: '', default_exec: '', is_admin: false, allowed_execs: ['sonnet'], created_at: '2026-01-01', ...over });

describe('AccountView', () => {
  it('uses the compact control deck with the approved Account section order under a mascot hero', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ name: 'Bob' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ model: '', modelProvider: '', discordUserId: '', whatsappNumber: '' })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    expect(await screen.findByRole('heading', { level: 1, name: 'Account' })).toBeInTheDocument();
    const rail = screen.getByRole('radiogroup', { name: 'Account sections' });
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual([
      'Account', 'Elowen AI', 'Memory', 'Personality', 'Notifications', 'Security', 'Terminal',
    ]);
    // The constellation is gone and the deck carries the mascot hero again, with the account's own
    // facts beside it. Every one of them comes from /auth/me and the model list the sections already
    // load, so the hero renders for a plain member too — it never touches the admin-only stats route.
    expect(await screen.findByRole('img', { name: 'Elowen' })).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();
    // The username stays a profile fact and is NOT repeated in the hero.
    expect(screen.getByTestId('spatial-content-surface')).toContainElement(screen.getByText('@bob'));
  });

  it('adds grant-filtered plugin account sections beside the profile', async () => {
    server.use(
      http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'github', url: '/plugins/github/web/hash.js', apiVersion: 3, nav: [], account: [{ id: 'connection', label: 'GitHub', icon: 'Github' }], settings: [], strings: { accountHint: 'Your GitHub identity.' } }])),
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ name: 'Bob' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ model: '', modelProvider: '' })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    const rail = await screen.findByRole('radiogroup', { name: 'Account sections' });
    expect(Array.from(rail.querySelectorAll('[role="radio"]')).map((node) => node.textContent)).toEqual([
      'Account', 'GitHub', 'Elowen AI', 'Memory', 'Personality', 'Notifications', 'Security', 'Terminal',
    ]);
  });

  it('saves only the platform link edited in this form, preserving a concurrent Teams TOFU link', async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ name: 'Bob' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ model: '', modelProvider: '', discordUserId: '', whatsappNumber: '', msteamsUserId: '' })),
      http.patch('*/api/auth/me/cli-settings', async ({ request }) => { patched = await request.json() as Record<string, unknown>; return HttpResponse.json({}); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'Linked accounts' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Discord ID' }), { target: { value: '123456789012345678' } });
    await waitFor(() => expect(patched).toEqual({ discordUserId: '123456789012345678' }));
  });

  // The bug this closes: the daemon supported `telegramUserId` end to end, but Account rendered three
  // hard-coded link fields and Telegram was not one of them — so nobody could ever link a Telegram
  // sender and every Telegram turn was dropped for having no account behind it.
  it('renders a field for every platform link, so a Telegram id can actually be saved', async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ name: 'Bob' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ model: '', modelProvider: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', msteamsUserId: '' })),
      http.patch('*/api/auth/me/cli-settings', async ({ request }) => { patched = await request.json() as Record<string, unknown>; return HttpResponse.json({}); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    // The links are one row that opens a drawer, so the fields live one click in.
    fireEvent.click(await screen.findByRole('button', { name: 'Linked accounts' }));
    for (const label of ['Discord ID', 'Microsoft Teams identity', 'Telegram ID', 'WhatsApp number']) {
      expect(await screen.findByRole('textbox', { name: label })).toBeInTheDocument();
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Telegram ID' }), { target: { value: '123456789' } });
    // Only the edited link goes out — the other three keep following the server.
    await waitFor(() => expect(patched).toEqual({ telegramUserId: '123456789' }));
  });

  // A link only matches a sender this instance can actually receive, so a field for a platform whose
  // adapter is not running is a box that can only ever be filled in wrong. The daemon names the platforms
  // worth offering; the page must not fall back to its own full list once it has that answer.
  it('offers a link field only for the platforms the daemon reports as live', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ name: 'Bob' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({
        model: '', modelProvider: '', discordUserId: '', whatsappNumber: '', telegramUserId: '', msteamsUserId: '',
        availableLinks: ['discordUserId'],
      })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'Linked accounts' }));
    expect(await screen.findByRole('textbox', { name: 'Discord ID' })).toBeInTheDocument();
    for (const label of ['Microsoft Teams identity', 'Telegram ID', 'WhatsApp number']) {
      expect(screen.queryByRole('textbox', { name: label })).toBeNull();
    }
  });

  // Disconnecting is the same edit as clearing the box by hand, so it must travel the same autosave path
  // and send the cleared link rather than merely emptying the input on screen.
  it('disconnects a linked platform by clearing the stored id', async () => {
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ name: 'Bob' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({
        model: '', modelProvider: '', discordUserId: '123456789012345678', availableLinks: ['discordUserId'],
      })),
      http.patch('*/api/auth/me/cli-settings', async ({ request }) => { patched = await request.json() as Record<string, unknown>; return HttpResponse.json({}); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    fireEvent.click(await screen.findByRole('button', { name: 'Linked accounts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(patched).toEqual({ discordUserId: '' }));
  });

  it('keeps the retired Default worker control out of Account', async () => {
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser({ default_exec: 'sonnet' }) })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ model: '', modelProvider: '' })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    expect(await screen.findByText('@bob')).toBeTruthy();
    expect(screen.queryByText('Default worker')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Manage: Default worker' })).toBeNull();
  });

  it('falls back to the profile section when a removed section id is persisted', async () => {
    localStorage.setItem('elowen.account.section', 'plugins'); // the Plugins tab no longer exists
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    // The stale value fails the allowed-list guard, so the default (profile) section renders.
    expect(await screen.findByText('@bob')).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Plugins' })).toBeNull();
  });

  it('retains a visited section\'s local controls while another account panel is active', async () => {
    localStorage.setItem('elowen.account.section', 'profile');
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser() })),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
      http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({
        model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '',
        autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'concise', personalityBody: '',
        discordUserId: '', whatsappNumber: '', autoRecall: true, autoLiveRecall: true, autoSave: true,
      })),
      http.patch('*/api/auth/me/cli-settings', () => HttpResponse.json({})),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    await screen.findByText('@bob');
    fireEvent.click(screen.getByRole('radio', { name: 'Personality' }));
    // PROTOTYPE(constellation): the style is a drawer-picked choice — wait for the seeded 'Concise'
    // chip, then open the picker and switch to Friendly.
    await waitFor(() => expect(screen.getByText('Concise')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Friendly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.getByText('Friendly')).toBeInTheDocument());

    // Navigate away: the panel is kept mounted but hidden (React <Activity>), so the chip is no
    // longer visible.
    fireEvent.click(screen.getByRole('radio', { name: 'Account' }));
    await waitFor(() => expect(screen.getByText('Friendly')).not.toBeVisible());
    fireEvent.click(screen.getByRole('radio', { name: 'Personality' }));
    // The visited panel stayed mounted, so the local pick survives navigating away and back. The reveal
    // from <Activity> hidden→visible is deferred, so wait for it rather than asserting synchronously.
    await waitFor(() => expect(screen.getByText('Friendly')).toBeVisible());
  });

  it('never reseeds the profile form over edits typed while a /auth/me refetch is in flight', async () => {
    let serverName = 'Bob';
    let patches = 0;
    let gets = 0;
    // Hold the refetch the autosave's invalidation triggers, so the user can keep typing while the
    // stale response is on the wire — the exact window where a blind reseed types over them.
    const gate: { release: (() => void) | null } = { release: null };
    server.use(
      http.get('*/api/auth/me', async () => {
        gets += 1;
        if (gets > 1) await new Promise<void>((resolve) => { gate.release = resolve; });
        return HttpResponse.json({ user: meUser({ name: serverName }) });
      }),
      http.patch('*/api/auth/me', async ({ request }) => {
        const body = await request.json() as { name?: string };
        patches += 1;
        serverName = body.name ?? serverName;
        return HttpResponse.json(meUser({ name: serverName }));
      }),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    const { wrapper: Wrapper, client } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    const nameInput = await screen.findByDisplayValue('Bob');
    fireEvent.change(nameInput, { target: { value: 'Bob Renamed' } });
    await waitFor(() => expect(patches).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(gate.release).not.toBeNull());

    // Still typing while the refetch hangs.
    fireEvent.change(nameInput, { target: { value: 'Bob Renamed Twice' } });
    gate.release?.();

    await waitFor(() => expect(client.getQueryData(['me'])).toMatchObject({ user: { name: 'Bob Renamed' } }));
    expect(nameInput).toHaveValue('Bob Renamed Twice');
    // Let the second edit's autosave land while the handlers are still installed.
    await waitFor(() => expect(patches).toBe(2), { timeout: 3000 });
  });

  it('saves only the edited field, so a change made elsewhere survives', async () => {
    // Another window renames the user while this form is being used to edit the e-mail. The autosave
    // must not carry its stale copy of the name back to the server.
    const stored = { name: 'Bob', email: 'bob@example.com' };
    let patched: Record<string, unknown> | null = null;
    server.use(
      http.get('*/api/auth/me', () => HttpResponse.json({ user: meUser(stored) })),
      http.patch('*/api/auth/me', async ({ request }) => {
        patched = await request.json() as Record<string, unknown>;
        if (typeof patched.name === 'string') stored.name = patched.name;
        if (typeof patched.email === 'string') stored.email = patched.email;
        return HttpResponse.json(meUser(stored));
      }),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    const emailInput = await screen.findByDisplayValue('bob@example.com');
    stored.name = 'Bob Renamed Elsewhere'; // the external change, made before this form's save goes out
    fireEvent.change(emailInput, { target: { value: 'new@example.com' } });

    await waitFor(() => expect(patched).not.toBeNull(), { timeout: 3000 });
    expect(patched).toEqual({ email: 'new@example.com' });
    expect(stored.name).toBe('Bob Renamed Elsewhere');
    // The untouched field keeps following /auth/me, so the refetch shows the external name — while the
    // edited field still holds what was typed here.
    expect(await screen.findByDisplayValue('Bob Renamed Elsewhere')).toBeInTheDocument();
    expect(emailInput).toHaveValue('new@example.com');
  });

  it('adopts a value another window wrote while this form\'s own save was in flight', async () => {
    // The saved edit is settled, not an edit in progress: once the refetch reports someone else's newer
    // name, this form must follow it instead of keeping its own echo and writing it back on the next save.
    const stored = { name: 'Bob', email: 'bob@example.com' };
    const patches: Record<string, unknown>[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    let gets = 0;
    server.use(
      http.get('*/api/auth/me', async () => {
        gets += 1;
        // Hold the refetch the save's invalidation triggers — the window another window writes into.
        if (gets === 2) await new Promise<void>((resolve) => { gate.release = resolve; });
        return HttpResponse.json({ user: meUser(stored) });
      }),
      http.patch('*/api/auth/me', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        patches.push(body);
        if (typeof body.name === 'string') stored.name = body.name;
        if (typeof body.email === 'string') stored.email = body.email;
        return HttpResponse.json({ user: meUser(stored) });
      }),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: [], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    const nameInput = await screen.findByDisplayValue('Bob');
    fireEvent.change(nameInput, { target: { value: 'Bob From Here' } });
    await waitFor(() => expect(patches).toHaveLength(1), { timeout: 3000 });
    await waitFor(() => expect(gate.release).not.toBeNull());

    stored.name = 'Bob From The Other Window'; // written elsewhere while the refetch hangs
    gate.release?.();

    expect(await screen.findByDisplayValue('Bob From The Other Window')).toBeInTheDocument();

    // Editing an unrelated field now must not carry the superseded name back to the server.
    fireEvent.change(await screen.findByDisplayValue('bob@example.com'), { target: { value: 'new@example.com' } });
    await waitFor(() => expect(patches).toHaveLength(2), { timeout: 3000 });
    expect(patches[1]).toEqual({ email: 'new@example.com' });
    expect(stored.name).toBe('Bob From The Other Window');
  });

  it('shows a retryable error instead of an infinite skeleton when /auth/me fails', async () => {
    let attempts = 0;
    server.use(
      http.get('*/api/auth/me', () => {
        attempts += 1;
        return attempts === 1 ? HttpResponse.json({ error: 'boom' }, { status: 500 }) : HttpResponse.json({ user: meUser() });
      }),
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet'], customModels: [], hiddenPresets: [], providers: {}, defaults: {} })),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EffectsProvider><UiScaleProvider><ToastProvider><AccountView /></ToastProvider></UiScaleProvider></EffectsProvider></Wrapper>);

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('@bob')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('@bob')).toBeInTheDocument());
  });
});
