import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { ToolPills } from '../../../modules/users/ToolPills';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { User, UserToolPill } from '../../../lib/types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const tool = (over: Partial<UserToolPill>): UserToolPill =>
  ({ name: 'x', label: 'X', icon: null, plugin: null, group: 'plugin', state: 'allowed', toggleable: true, ...over });

/** The account row the panel holds. `allowed_tools` is the grant the save starts from. */
const account = (over: Partial<User> = {}): User => ({
  id: 1, username: 'bob', name: '', email: '', avatar: '', created_at: '2026-01-02', is_admin: false,
  allowed_execs: [], disabled_tools: [], allowed_tools: [], granted_plugins: [],
  default_exec: '', advisor_exec: '', advisor_autostart: false, ...over,
});

function mountWith(tools: UserToolPill[], user: User = account()) {
  server.use(http.get('*/api/users/1/tools', () => HttpResponse.json(tools)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ToolPills user={user} /></ToastProvider></Wrapper>);
}

/** Mounts against a fixed pill list and captures the PATCH body the save sends. */
function mountForSave(tools: UserToolPill[], user: User) {
  const captured: { body: UserPatchBody | null } = { body: null };
  server.use(
    http.get('*/api/users/1/tools', () => HttpResponse.json(tools)),
    http.patch('*/api/users/1', async ({ request }) => {
      captured.body = await request.json() as UserPatchBody;
      return HttpResponse.json({ id: 1 });
    }),
  );
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ToolPills user={user} /></ToastProvider></Wrapper>);
  return captured;
}

type UserPatchBody = { allowed_tools?: string[]; disabled_tools?: string[] };

describe('ToolPills', () => {
  it('summarizes enabled vs total tools and the plugin count', async () => {
    mountWith([
      tool({ name: 'discord_send', plugin: 'discord', state: 'allowed' }),
      tool({ name: 'discord_read', plugin: 'discord', state: 'disabled' }),
      tool({ name: 'MemorySearch', group: 'memory', state: 'inherited', toggleable: false }),
    ]);
    expect(await screen.findByText('2 of 3 tools enabled · 1 plugins')).toBeTruthy();
    // Sample chips show enabled tools only.
    expect(screen.getByText('discord_send')).toBeTruthy();
    expect(screen.getByText('MemorySearch')).toBeTruthy();
    expect(screen.queryByText('discord_read')).toBeNull();
  });

  // An ungranted plugin tool cannot be run by this account. Showing it checked, with the same "built-in"
  // badge an inherited memory tool gets, told the admin the user HELD a tool they cannot invoke — the
  // exact lie the API stopped telling, moved one layer up.
  it('shows an ungranted tool as unavailable, not as a checked built-in', async () => {
    mountWith([
      tool({ name: 'Bash', plugin: 'terminal', state: 'unavailable', toggleable: false }),
      tool({ name: 'MemorySearch', group: 'memory', state: 'inherited', toggleable: false }),
    ]);
    expect(await screen.findByText('1 of 2 tools enabled · 1 plugins')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /manage/i }));

    const bash = await screen.findByRole('button', { name: /Bash/ });
    // aria-pressed also drives the accent highlight, so a wrong value both misreports and mis-styles it.
    expect(bash.getAttribute('aria-pressed')).toBe('false');
    expect(bash.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('not granted')).toBeTruthy();
    // The inherited built-in keeps its own wording; the two reasons must not look alike.
    expect(screen.getByText('built-in')).toBeTruthy();
  });

  // The chip icon is derived from the tool's NAME, never from `icon`: that field is whatever emoji a
  // plugin manifest declared, and it put a question mark, a laptop and a recycling symbol into a drawer
  // whose every other icon is a monochrome Lucide glyph.
  it('draws a sample chip with a Lucide icon and ignores the manifest emoji', async () => {
    mountWith([tool({ name: 'discord_send', label: 'Send', icon: '💬', plugin: 'discord' })]);
    const chip = (await screen.findByText('discord_send')).closest('span')!.parentElement!;
    expect(chip.querySelector('svg.lucide')).toBeTruthy();
    expect(chip.textContent).not.toContain('💬');
  });

  it('shows an empty state when the user has no tools', async () => {
    mountWith([]);
    expect(await screen.findByText('No tools available')).toBeTruthy();
  });

  it('the manage modal groups tools by plugin and marks built-ins as disabled rows', async () => {
    mountWith([
      tool({ name: 'discord_send', plugin: 'discord' }),
      tool({ name: 'wa_send', plugin: 'whatsapp' }),
      tool({ name: 'MemorySearch', group: 'memory', state: 'inherited', toggleable: false }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage tool access' }));
    expect(await screen.findByRole('heading', { name: 'discord' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'whatsapp' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Memory' })).toBeTruthy();
    const builtIn = screen.getByRole('button', { name: /MemorySearch/ });
    expect(builtIn).toBeDisabled();
    expect(screen.getByText('built-in')).toBeTruthy();
  });

  it('unchecking a plugin tool and saving shrinks allowed_tools', async () => {
    const captured = mountForSave([
      tool({ name: 'discord_send', plugin: 'discord', state: 'allowed' }),
      tool({ name: 'discord_read', plugin: 'discord', state: 'allowed' }),
    ], account({ allowed_tools: ['discord_send', 'discord_read'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage tool access' }));
    fireEvent.click(await screen.findByRole('button', { name: /discord_send/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(captured.body?.allowed_tools).toEqual(['discord_read']));
    // The deny-list was not involved in this change and must not be rewritten.
    expect(captured.body?.disabled_tools).toBeUndefined();
  });

  it('re-checking a withheld tool grants it and clears the older deny-list entry', async () => {
    const captured = mountForSave([
      tool({ name: 'discord_send', plugin: 'discord', state: 'disabled' }),
      tool({ name: 'discord_read', plugin: 'discord', state: 'disabled' }),
    ], account({ allowed_tools: [], disabled_tools: ['discord_send', 'discord_read'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage tool access' }));
    fireEvent.click(await screen.findByRole('button', { name: /discord_send/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(captured.body?.allowed_tools).toEqual(['discord_send']));
    // The deny-list is still honoured at turn time, so a checked box has to leave it too — otherwise the
    // grant is overruled and the tool stays dead.
    expect(captured.body?.disabled_tools).toEqual(['discord_read']);
  });

  // A tool whose plugin is disabled or whose MCP server is offline is reported `unavailable` and cannot be
  // toggled. Saving the checked set would drop it from the grant, so switching that plugin off and on
  // again would silently cost the account a tool an admin deliberately granted.
  it('keeps the grant of an unavailable tool across an unrelated save', async () => {
    const captured = mountForSave([
      tool({ name: 'discord_send', plugin: 'discord', state: 'allowed' }),
      tool({ name: 'discord_gone', plugin: 'discord', state: 'unavailable', toggleable: false }),
    ], account({ allowed_tools: ['discord_send', 'discord_gone'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage tool access' }));
    fireEvent.click(await screen.findByRole('button', { name: /discord_send/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(captured.body?.allowed_tools).toEqual(['discord_gone']));
  });

  // `['*']` is the pre-migration "unrestricted" marker, not a tool named `*`. Writing it back would leave
  // the account unrestricted however many boxes the admin unchecked.
  it('converts a wildcard grant into a concrete list instead of writing `*` back', async () => {
    const captured = mountForSave([
      tool({ name: 'discord_send', plugin: 'discord', state: 'allowed' }),
      tool({ name: 'discord_read', plugin: 'discord', state: 'allowed' }),
      tool({ name: 'MemorySearch', group: 'memory', state: 'inherited', toggleable: false }),
    ], account({ allowed_tools: ['*'] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage tool access' }));
    fireEvent.click(await screen.findByRole('button', { name: /discord_send/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    // Only the plugin tools become concrete: the inherited built-in is not part of the grant.
    await waitFor(() => expect(captured.body?.allowed_tools).toEqual(['discord_read']));
  });
});
