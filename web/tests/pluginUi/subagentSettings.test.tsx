import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { SubagentsSettings } from '../../../plugins/subagent/web-src/SubagentsSettings';
import manifest from '../../../plugins/subagent/elowen-plugin.json';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

// The moved editor resolves everything through window.ElowenUiRuntime — install the REAL runtime,
// so this exercises the production contract the bundle runs against.
ensurePluginUiRuntime();

const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'subagent', url: '/plugins/subagent/web/index.js', apiVersion: 1, nav: [], settings: [], strings }])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const AGENTS = [
  { name: 'explore', description: 'Read-only exploration.', tools: 'read-only', source: 'builtin', canDelete: false },
  { name: 'triage', description: 'Bug triage.', tools: ['Read', 'Search'], source: 'user', canDelete: true, body: 'Investigate.' },
];

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><SubagentsSettings surface="deck" /></ToastProvider></Wrapper>);
};

describe('subagent SubagentsSettings', () => {
  it('lists built-in and user agents with their tools badge', async () => {
    server.use(http.get('*/api/plugins/agents/list', () => HttpResponse.json(AGENTS)));
    mount();
    expect(await screen.findByText('explore')).toBeInTheDocument();
    expect(screen.getByText('triage')).toBeInTheDocument();
    expect(screen.getByText(strings.toolsReadOnly!)).toBeInTheDocument(); // preset keyword resolves to its label
    expect(screen.getByText('Read, Search')).toBeInTheDocument();         // custom list renders verbatim
  });

  it('saves a user agent with a custom tool list through PUT /plugins/agents/:name', async () => {
    let saved: unknown; let savedName = '';
    server.use(
      http.get('*/api/plugins/agents/list', () => HttpResponse.json(AGENTS)),
      http.put('*/api/plugins/agents/:name', async ({ params, request }) => {
        savedName = String(params.name); saved = await request.json();
        return HttpResponse.json({ ok: true }, { status: 201 });
      }),
    );
    mount();
    fireEvent.click((await screen.findAllByRole('button', { name: strings.add }))[0]!);
    // The form lives in the workspace detail drawer; the page behind it has a search box of its own.
    const form = within(await screen.findByRole('dialog'));
    fireEvent.change(form.getByPlaceholderText('reviewer'), { target: { value: 'reviewer' } });
    fireEvent.change(form.getAllByRole('textbox')[1]!, { target: { value: 'Reviews diffs.' } });
    fireEvent.change(form.getByRole('combobox'), { target: { value: 'custom' } });
    fireEvent.change(form.getByPlaceholderText('Read, Search, Bash'), { target: { value: 'Read, Grep' } });
    fireEvent.change(form.getByPlaceholderText(strings.bodyPlaceholder!), { target: { value: 'Be thorough.' } });
    fireEvent.click(form.getByRole('button', { name: strings.save }));
    await waitFor(() => expect(saved).toBeTruthy());
    expect(savedName).toBe('reviewer');
    expect(saved).toEqual({ description: 'Reviews diffs.', tools: ['Read', 'Grep'], body: 'Be thorough.' });
  });
});
