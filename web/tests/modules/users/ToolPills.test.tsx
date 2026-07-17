import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { ToolPills } from '../../../modules/users/ToolPills';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { UserToolPill } from '../../../lib/types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const tool = (over: Partial<UserToolPill>): UserToolPill =>
  ({ name: 'x', label: 'X', icon: null, plugin: null, group: 'plugin', state: 'allowed', toggleable: true, ...over });

function mountWith(tools: UserToolPill[]) {
  server.use(http.get('*/api/users/1/tools', () => HttpResponse.json(tools)));
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><ToolPills userId={1} /></ToastProvider></Wrapper>);
}

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

  it('renders a sample chip with the manifest emoji icon', async () => {
    mountWith([tool({ name: 'discord_send', label: 'Send', icon: '💬', plugin: 'discord' })]);
    expect(await screen.findByText('discord_send')).toBeTruthy();
    expect(screen.getByText('💬')).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByRole('heading', { name: 'discord' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'whatsapp' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Memory' })).toBeTruthy();
    const builtIn = screen.getByRole('button', { name: /MemorySearch/ });
    expect(builtIn).toBeDisabled();
    expect(screen.getByText('built-in')).toBeTruthy();
  });

  it('unchecking a plugin tool and saving PATCHes it into disabled_tools', async () => {
    let patched: { disabled_tools?: string[] } | null = null;
    server.use(
      http.get('*/api/users/1/tools', () => HttpResponse.json([
        tool({ name: 'discord_send', plugin: 'discord', state: 'allowed' }),
        tool({ name: 'discord_gone', plugin: 'discord', state: 'unavailable' }),
      ])),
      http.patch('*/api/users/1', async ({ request }) => { patched = await request.json() as { disabled_tools?: string[] }; return HttpResponse.json({ id: 1 }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ToolPills userId={1} /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: /discord_send/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    // Only the changed toggle lands in the deny-list — the untouched `unavailable` tool stays out.
    await waitFor(() => expect(patched?.disabled_tools).toEqual(['discord_send']));
  });

  it('re-checking a disabled tool removes it from disabled_tools', async () => {
    let patched: { disabled_tools?: string[] } | null = null;
    server.use(
      http.get('*/api/users/1/tools', () => HttpResponse.json([
        tool({ name: 'discord_send', plugin: 'discord', state: 'disabled' }),
        tool({ name: 'discord_read', plugin: 'discord', state: 'disabled' }),
      ])),
      http.patch('*/api/users/1', async ({ request }) => { patched = await request.json() as { disabled_tools?: string[] }; return HttpResponse.json({ id: 1 }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ToolPills userId={1} /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: /discord_send/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patched?.disabled_tools).toEqual(['discord_read']));
  });
});
