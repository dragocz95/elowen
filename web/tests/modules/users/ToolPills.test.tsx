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
  it('renders a plugin tool with its manifest emoji icon', async () => {
    mountWith([tool({ name: 'discord_send', label: 'Send', icon: '💬', plugin: 'discord' })]);
    expect(await screen.findByText('discord_send')).toBeTruthy();
    expect(screen.getByText('💬')).toBeTruthy();
  });

  it('falls back to a glyph when a tool has no icon', async () => {
    mountWith([tool({ name: 'no_icon', icon: null })]);
    const item = await screen.findByText('no_icon');
    // No emoji rendered — the fallback lucide icon is an <svg> inside the pill.
    expect(item.closest('li')!.querySelector('svg')).toBeTruthy();
  });

  it('renders in the order the server returns (allowed first)', async () => {
    mountWith([
      tool({ name: 'a_allowed', state: 'allowed' }),
      tool({ name: 'b_inherited', group: 'memory', state: 'inherited' }),
      tool({ name: 'c_unavailable', group: 'orca', state: 'unavailable' }),
    ]);
    await screen.findByText('a_allowed');
    const names = Array.from(document.querySelectorAll('li')).map((li) => li.textContent);
    expect(names[0]).toContain('a_allowed');
    expect(names[names.length - 1]).toContain('c_unavailable');
  });

  it('collapses past the visible limit and expands/collapses on the toggle', async () => {
    mountWith(Array.from({ length: 16 }, (_, i) => tool({ name: `tool_${String(i).padStart(2, '0')}` })));
    await screen.findByText('tool_00');
    // 12 shown initially, so tool_12 is hidden until expanded.
    expect(screen.queryByText('tool_12')).toBeNull();
    const toggle = document.querySelector('[aria-expanded]') as HTMLElement; // the "+ N more" control
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('tool_12')).toBeTruthy());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByText('tool_12')).toBeNull());
  });

  it('clicking a plugin pill toggles it in the user\'s disabled_tools', async () => {
    let patched: { disabled_tools?: string[] } | null = null;
    server.use(
      http.get('*/api/users/1/tools', () => HttpResponse.json([tool({ name: 'discord_send', plugin: 'discord', state: 'allowed', toggleable: true })])),
      http.patch('*/api/users/1', async ({ request }) => { patched = await request.json() as { disabled_tools?: string[] }; return HttpResponse.json({ id: 1 }); }),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><ToolPills userId={1} /></ToastProvider></Wrapper>);
    fireEvent.click(await screen.findByRole('button', { name: /discord_send/ }));
    await waitFor(() => expect(patched?.disabled_tools).toEqual(['discord_send']));
  });

  it('shows an empty state when the user has no tools', async () => {
    mountWith([]);
    expect(await screen.findByText('No tools available')).toBeTruthy();
  });
});
