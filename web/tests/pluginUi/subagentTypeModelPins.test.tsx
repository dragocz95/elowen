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

/** The built-in agents' model pins, exercised through the REAL plugin runtime the bundle ships against. */

ensurePluginUiRuntime();

const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

const AGENTS = [
  { name: 'explore', description: 'Read-only codebase exploration. Use it for broad fan-out searches.', tools: 'read-only', source: 'builtin', canDelete: false },
  { name: 'plan', description: 'Designs an implementation plan. Use it before writing code.', tools: 'inherit', source: 'builtin', canDelete: false },
  { name: 'triage', description: 'Bug triage.', tools: ['Read'], source: 'user', canDelete: true, body: 'Investigate.' },
];

const MODELS = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus' },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5', exec: 'elowen:openai/gpt-5' },
];

const userConfig = { current: { name: 'subagent', userConfigSchema: [], config: {} as Record<string, unknown>, secretsSet: [], revision: 3 } };
const saved: { body?: { values?: Record<string, unknown>; expectedRevision?: number } } = {};

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'subagent', url: '/plugins/subagent/web/index.js', apiVersion: 1, nav: [], settings: [], strings }])),
  http.get('*/api/plugins/agents/list', () => HttpResponse.json(AGENTS)),
  http.get('*/api/brain/models', () => HttpResponse.json(MODELS)),
  http.get('*/api/plugins/user-config', () => HttpResponse.json([userConfig.current])),
  http.patch('*/api/plugins/subagent/user-config', async ({ request }) => {
    saved.body = await request.json() as typeof saved.body;
    userConfig.current = { ...userConfig.current, config: { ...saved.body!.values }, revision: userConfig.current.revision + 1 };
    return HttpResponse.json(userConfig.current);
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); saved.body = undefined; });
afterAll(() => server.close());

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><SubagentsSettings surface="deck" /></ToastProvider></Wrapper>);
};

const pickerFor = (agent: string) => screen.getByRole('button', { name: `${strings.pinsTitle}: ${agent}` });

describe('subagent built-in agent model pins', () => {
  it('offers one picker per built-in agent and none for a custom one', async () => {
    userConfig.current = { ...userConfig.current, config: {} };
    mount();
    expect(await screen.findByText(strings.pinsTitle!)).toBeInTheDocument();
    expect(pickerFor('explore')).toBeInTheDocument();
    expect(pickerFor('plan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `${strings.pinsTitle}: triage` })).toBeNull();
    // Unset reads as Automatic, not as a model nothing is actually running on.
    expect(pickerFor('explore')).toHaveTextContent(strings.pinAutomatic!);
  });

  it('saves a picked model as an atomic provider/model pair and shows it after the reload', async () => {
    userConfig.current = { ...userConfig.current, config: {}, revision: 3 };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `${strings.pinsTitle}: explore` }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(await dialog.findByRole('button', { name: 'claude-opus' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(saved.body).toBeTruthy());
    expect(saved.body!.values).toMatchObject({ 'typeModel.explore': 'anthropic::claude-opus' });
    expect(saved.body!.expectedRevision).toBe(3);
    // The saved pin comes back from the store and the row states it.
    await waitFor(() => expect(pickerFor('explore')).toHaveTextContent('claude-opus'));
  });

  it('marks a stored pin the catalog no longer offers instead of claiming it is active', async () => {
    userConfig.current = { ...userConfig.current, config: { 'typeModel.plan': 'anthropic::retired-model' }, revision: 9 };
    mount();
    await screen.findByText(strings.pinsTitle!);
    await waitFor(() => expect(pickerFor('plan')).toHaveTextContent(strings.pinUnavailable!));
    // The other rows are unaffected by one unavailable pin.
    expect(pickerFor('explore')).toHaveTextContent(strings.pinAutomatic!);
  });
});
