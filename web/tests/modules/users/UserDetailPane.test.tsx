import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { UserDetailPane } from '../../../modules/users/UserDetailPane';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Project, User } from '../../../lib/types';

const server = setupServer(
  http.get('*/api/users/:id/stats', () => HttpResponse.json({ memoryCount: 0, sessionCount: 0, topModel: null })),
  http.get('*/api/users/:id/tools', () => HttpResponse.json([])),
  http.get('*/api/plugins', () => HttpResponse.json([])),
  http.get('*/api/plugins/ui', () => HttpResponse.json([])),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
beforeEach(() => { loadPluginUi.mockReset(); });
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const user = (over: Partial<User> = {}): User => ({
  id: 2, username: 'bob', name: '', email: '', avatar: '', created_at: '2026-01-02', is_admin: false,
  allowed_execs: [], disabled_tools: [], allowed_tools: [], granted_plugins: [], default_exec: '', advisor_exec: '', advisor_autostart: false, ...over,
});

const project = (id: number, slug: string): Project => ({ id, slug, path: `/p/${slug}`, notes: '', icon: '' });

function StatefulUserPanel({ user: selected }: { user: User }) {
  const [mountedFor] = useState(selected.id);
  return <div>Environment for {selected.username} mounted #{mountedFor}</div>;
}

function mount(u: User, projects: Project[] = []) {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper>
      <ToastProvider>
        <UserDetailPane user={u} projects={projects} />
      </ToastProvider>
    </Wrapper>,
  );
}

describe('UserDetailPane', () => {
  it('summarizes an unrestricted user from the live brain catalog', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
        { provider: 'z-ai', providerLabel: 'Z.ai', model: 'glm-5.3-flash', exec: 'z-ai/glm-5.3-flash', source: 'api-key', contextWindow: 1000000, contextWindowSet: true },
      ])),
    );
    mount(user());
    expect(await screen.findByText('All models allowed · 2 available')).toBeTruthy();
    expect(screen.getByText('claude-opus-5')).toBeTruthy();
  });

  it('summarizes a restricted user with real brain-provider counts', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-sonnet-5', exec: 'anthropic/claude-sonnet-5', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
    );
    mount(user({ allowed_execs: ['anthropic/claude-opus-5', 'anthropic/claude-sonnet-5'] }));
    expect(await screen.findByText('2 models · 1 providers')).toBeTruthy();
  });

  // The admin allow-list shows brain models by the name the catalog gives them — the exec is the row's
  // identity, not its label, so two providers offering the same model stay two grantable entries.
  it('labels brain execs from the catalog and keeps same-named models from two providers apart', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      server.use(
        http.get('*/api/users/2/projects', () => HttpResponse.json([])),
        http.get('*/api/brain/models', () => HttpResponse.json([
          { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'elowen:anthropic/claude-opus-5', legacyExec: 'elowen:anthropic/claude-opus-5', program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
          { provider: 'relay', providerLabel: 'Relay', model: 'claude-opus-5', exec: 'elowen:relay/claude-opus-5', legacyExec: 'elowen:relay/claude-opus-5', program: 'elowen', source: 'relay', contextWindow: 200000, contextWindowSet: false },
        ])),
      );
      mount(user());
      fireEvent.click(await screen.findByRole('button', { name: 'Manage allowed models' }));
      const rows = await screen.findAllByRole('button', { name: /claude-opus-5/ });
      expect(rows).toHaveLength(2);
      // The clean model name is shown; the raw spec is not what the admin reads, while the full exec keeps
      // equal visible labels distinct as React keys in the compact summary.
      expect(rows.every((r) => r.textContent?.includes('elowen:'))).toBe(false);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('shows the bare catalog name in the Users selection summary', async () => {
    const exec = 'chatgpt-account/openai/gpt-5.6-sol';
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'openai/gpt-5.6-sol', exec, legacyExec: `elowen:${exec}`, program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
    );
    mount(user({ allowed_execs: [exec] }));
    expect(await screen.findByText('openai/gpt-5.6-sol')).toBeTruthy();
    expect(screen.queryByText('Účet ChatGPT/openai/gpt-5.6-sol')).toBeNull();
  });

  it('offers only models present in the live brain catalog', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', legacyExec: 'elowen:anthropic/claude-opus-5', program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
    );
    mount(user());
    fireEvent.click(await screen.findByRole('button', { name: 'Manage allowed models' }));
    expect(await screen.findByRole('button', { name: /claude-opus-5/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Claude Sonnet 4\.5/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /qwen3\.8-max/ })).toBeNull();
  });

  // A stale grant still restricts the account server-side, even when its provider disappeared from the
  // live catalog. Keep that restriction visible instead of replacing it with an em-dash or "all models".
  it('does not hide a user restriction when its model is no longer in the catalog', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([])),
    );
    mount(user({ allowed_execs: ['alibaba/qwen3.8-max'] }));
    expect(await screen.findByText('1 models · 0 providers')).toBeTruthy();
    expect(screen.queryByText(/All models allowed/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage allowed models' })).toBeTruthy();
  });

  it('saving the models modal PATCHes live brain execs', async () => {
    let patched: { id?: string; body?: unknown } = {};
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
      http.patch('*/api/users/:id', async ({ params, request }) => {
        patched = { id: String(params.id), body: await request.json() };
        return HttpResponse.json({ id: 2 });
      }),
    );
    mount(user());
    fireEvent.click(await screen.findByRole('button', { name: 'Manage allowed models' }));
    expect(await screen.findByRole('heading', { name: 'Anthropic' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Claude Code' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'claude-opus-5' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patched.id).toBe('2'));
    expect((patched.body as { allowed_execs: string[] }).allowed_execs).toEqual(['anthropic/claude-opus-5']);
  });

  // The manage modal separates brain models under one header per real catalog provider. A model id may
  // itself contain a slash, so provider grouping must use the structured provider field and preserve the
  // complete exec through the save payload.
  it('separates brain models under their own brand-iconed provider headers and keeps a slash model id whole', async () => {
    const exec = 'chatgpt-account/openai/gpt-5.6-sol';
    let patched: { body?: unknown } = {};
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', legacyExec: 'elowen:anthropic/claude-opus-5', program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
        { provider: 'zai', providerLabel: 'Z.ai', model: 'glm-5.2', exec: 'zai/glm-5.2', legacyExec: 'elowen:zai/glm-5.2', program: 'elowen', source: 'api-key', contextWindow: 200000, contextWindowSet: false },
        { provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'openai/gpt-5.6-sol', exec, legacyExec: `elowen:${exec}`, program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
      http.patch('*/api/users/:id', async ({ request }) => {
        patched = { body: await request.json() };
        return HttpResponse.json({ id: 2 });
      }),
    );
    mount(user());
    fireEvent.click(await screen.findByRole('button', { name: 'Manage allowed models' }));

    // One header per real brain provider, each carrying its resolved brand mark. No legacy worker group
    // may reappear beside them.
    const headerMark = (name: string) => screen.getByRole('heading', { name }).querySelector('[data-brand-mark]');
    for (const name of ['Anthropic', 'Z.ai', 'Účet ChatGPT']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
      expect(headerMark(name)).toBeTruthy();
    }
    expect(screen.queryByRole('heading', { name: 'Claude Code' })).toBeNull();
    // The group filter chips carry the same brand mark with the human label.
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Účet ChatGPT' }).querySelector('[data-brand-mark]')).toBeTruthy();

    // No "Elowen AI" umbrella group over the brain rows, and the slash never became a provider boundary.
    expect(screen.queryByRole('heading', { name: 'Elowen AI' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'chatgpt-account' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'openai' })).toBeNull();

    // Exactly one row for the model, living in the Účet ChatGPT section — not split across two groups.
    const rows = screen.getAllByRole('button', { name: 'openai/gpt-5.6-sol' });
    expect(rows).toHaveLength(1);
    const section = rows[0]!.closest('section')!;
    expect(within(section).getByRole('heading', { name: 'Účet ChatGPT' })).toBeTruthy();
    expect(within(section).queryByRole('button', { name: /Claude Sonnet 4\.5/ })).toBeNull();

    // Saving grants the FULL exec — the identifier survives the round-trip unsplit.
    fireEvent.click(rows[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(patched.body).toBeTruthy());
    expect((patched.body as { allowed_execs: string[] }).allowed_execs).toEqual([exec]);
  });

  it('counts the distinct live brain providers behind the grants', async () => {
    const chatgptExec = 'chatgpt-account/openai/gpt-5.6-sol';
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
        { provider: 'z-ai', providerLabel: 'Z.ai', model: 'glm-5.3-flash', exec: 'z-ai/glm-5.3-flash', source: 'api-key', contextWindow: 1000000, contextWindowSet: true },
        { provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'openai/gpt-5.6-sol', exec: chatgptExec, source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
    );
    mount(user({ allowed_execs: ['anthropic/claude-opus-5', 'z-ai/glm-5.3-flash', chatgptExec] }));
    expect(await screen.findByText('3 models · 3 providers')).toBeTruthy();
  });

  it('mounts a generic plugin panel with the selected User DTO', async () => {
    server.use(
      http.get('*/api/users/:id/projects', () => HttpResponse.json([])),
      http.get('*/api/plugins/ui', () => HttpResponse.json([{
        name: 'sandbox', url: '/plugins/sandbox/web/hash.js', apiVersion: 5, nav: [], account: [],
        user: [{ id: 'environment', label: 'Development environment', icon: 'Box' }], project: [], settings: [], strings: {},
      }])),
    );
    loadPluginUi.mockResolvedValue({
      requiresApiVersion: 5,
      user: { environment: StatefulUserPanel },
    });

    const { wrapper: Wrapper } = createWrapper();
    const view = render(<Wrapper><ToastProvider><UserDetailPane user={user({ name: 'Bob' })} projects={[]} /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Development environment')).toBeInTheDocument();
    expect(await screen.findByText('Environment for bob mounted #2')).toBeInTheDocument();
    expect(loadPluginUi).toHaveBeenCalledWith('sandbox', '/plugins/sandbox/web/hash.js', undefined);

    view.rerender(<Wrapper><ToastProvider><UserDetailPane user={user({ id: 3, username: 'amy', name: 'Amy' })} projects={[]} /></ToastProvider></Wrapper>);
    expect(await screen.findByText('Environment for amy mounted #3')).toBeInTheDocument();
  });

  it('summarizes project assignments and saves the diff as individual assign/unassign calls', async () => {
    const assignedTo: number[] = [];
    const unassigned: number[] = [];
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([1])),
      http.post('*/api/users/2/projects', async ({ request }) => {
        assignedTo.push((await request.json() as { projectId: number }).projectId);
        return HttpResponse.json({ ok: true });
      }),
      http.delete('*/api/users/2/projects/:pid', ({ params }) => {
        unassigned.push(Number(params.pid));
        return HttpResponse.json({ ok: true });
      }),
    );
    mount(user(), [project(1, 'alpha'), project(2, 'beta')]);
    expect(await screen.findByText('1 of 2 projects assigned')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage project access' }));
    // Single group → no filter chips row.
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /beta/ })); // assign beta
    fireEvent.click(screen.getByRole('button', { name: /alpha/ })); // unassign alpha
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(assignedTo).toEqual([2]));
    await waitFor(() => expect(unassigned).toEqual([1]));
  });

  // The pane stacks four managed selections. They all read "Manage", so a screen reader user heard the
  // same button name four times with nothing to tell them apart — each one has to name what it manages.
  it('gives every manage button in the drawer its own accessible name', async () => {
    server.use(
      http.get('*/api/users/2/projects', () => HttpResponse.json([])),
      http.get('*/api/brain/models', () => HttpResponse.json([
        { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'anthropic/claude-opus-5', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
      ])),
      http.get('*/api/users/2/tools', () => HttpResponse.json([
        { name: 'ReadFile', label: 'ReadFile', icon: '💻', plugin: 'sandbox', group: 'plugin', state: 'allowed', toggleable: true },
      ])),
      http.get('*/api/plugins', () => HttpResponse.json([
        { name: 'sandbox', version: '1.0.0', enabled: true, removed: false, userGrantable: true },
      ])),
    );
    mount(user(), [project(1, 'alpha')]);

    // Every block loads from its own query, so wait until all four have arrived before comparing.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Manage / })).toHaveLength(4));
    const names = screen.getAllByRole('button', { name: /^Manage / }).map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'Manage project access',
      'Manage allowed models',
      'Manage granted plugins',
      'Manage tool access',
    ]);
  });
});

describe('UserDetailPane — editing name and username', () => {
  it('sends both fields and shows the new identity', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    let sent: unknown = null;
    server.use(http.patch('*/api/users/2', async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json({ ...user(), name: 'Bob Novák', username: 'bob.novak' });
    }));
    mount(user());

    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '  Bob Novák  ' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob.novak' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Whitespace is trimmed before it becomes a login credential.
    await waitFor(() => expect(sent).toEqual({ name: 'Bob Novák', username: 'bob.novak' }));
    await screen.findByText('Name saved');
  });

  it('names a taken username instead of the generic save error', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    server.use(http.patch('*/api/users/2', () => HttpResponse.json({ error: 'username taken' }, { status: 409 })));
    mount(user());

    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('That username is already taken')).toBeTruthy();
    // The form stays open on a refusal so the admin can correct the name instead of retyping it.
    expect(screen.getByLabelText('Username')).toBeTruthy();
  });

  it('will not submit an empty login name', async () => {
    server.use(http.get('*/api/users/2/projects', () => HttpResponse.json([])));
    let called = false;
    server.use(http.patch('*/api/users/2', () => { called = true; return HttpResponse.json(user()); }));
    mount(user());

    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(called).toBe(false));
  });
});
