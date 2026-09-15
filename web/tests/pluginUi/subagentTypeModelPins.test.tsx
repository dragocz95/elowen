import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ensurePluginUiRuntime, PLUGIN_UI_API_VERSION } from '../../lib/pluginUi';
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
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'anthropic/claude-opus' },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5', exec: 'openai/gpt-5' },
];

const MEMBER = { id: 1, username: 'mia', is_admin: false };
const me = { current: MEMBER as { id: number; username: string; is_admin: boolean } };
const userConfig = {
  current: { name: 'subagent', userConfigSchema: [], config: {} as Record<string, unknown>, secretsSet: [], revision: 3, placement: 'pluginPage' },
};
const saved: { body?: { values?: Record<string, unknown>; expectedRevision?: number } } = {};

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'subagent', url: '/plugins/subagent/web/index.js', apiVersion: 1, nav: [], settings: [], strings }])),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: me.current })),
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
afterEach(() => { server.resetHandlers(); saved.body = undefined; me.current = MEMBER; });
afterAll(() => server.close());

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><SubagentsSettings surface="deck" /></ToastProvider></Wrapper>);
};

const pickerFor = (agent: string) => screen.getByRole('button', { name: `${strings.pinsTitle}: ${agent}` });

/** The page must not require a plugin UI contract newer than the one the host already publishes. A bump is
 *  a shared, instance-wide claim about what `window.ElowenUiRuntime` offers, and two changes raising it
 *  for different reasons leave one number describing two different surfaces. */
describe('subagent page runtime contract', () => {
  it('asks for no runtime version the host does not already publish', () => {
    const required = (manifest as { web: { requiresApiVersion: number } }).web.requiresApiVersion;
    expect(required).toBeLessThanOrEqual(PLUGIN_UI_API_VERSION);
    expect(PLUGIN_UI_API_VERSION).toBe(16);
  });

  it('reads and writes the account\'s own settings through the generic query seam, not a hook of its own', () => {
    const hooks = window.ElowenUiRuntime?.hooks as Record<string, unknown> | undefined;
    expect(hooks?.useQuery).toBeTypeOf('function');
    expect(hooks?.useMutation).toBeTypeOf('function');
    // A dedicated runtime hook for per-account plugin config would be a NEW published contract, and the
    // next version number is spoken for elsewhere.
    expect(hooks?.useUserPluginConfigs).toBeUndefined();
    expect(hooks?.useSaveUserPluginConfig).toBeUndefined();
  });
});

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

  it('saves a picked model as the canonical provider/model exec and shows it after the reload', async () => {
    userConfig.current = { ...userConfig.current, config: {}, revision: 3 };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `${strings.pinsTitle}: explore` }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.click(await dialog.findByRole('button', { name: 'claude-opus' }));
    fireEvent.click(dialog.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(saved.body).toBeTruthy());
    expect(saved.body!.values).toMatchObject({ 'typeModel.explore': 'anthropic/claude-opus' });
    expect(saved.body!.expectedRevision).toBe(3);
    // The saved pin comes back from the store and the row states it.
    await waitFor(() => expect(pickerFor('explore')).toHaveTextContent('claude-opus'));
  });

  it('marks a stored pin the catalog no longer offers instead of claiming it is active', async () => {
    userConfig.current = { ...userConfig.current, config: { 'typeModel.plan': 'anthropic/retired-model' }, revision: 9 };
    mount();
    await screen.findByText(strings.pinsTitle!);
    await waitFor(() => expect(pickerFor('plan')).toHaveTextContent(strings.pinUnavailable!));
    // The other rows are unaffected by one unavailable pin.
    expect(pickerFor('explore')).toHaveTextContent(strings.pinAutomatic!);
  });
});

/** Same page, two audiences. Everyone chooses their own agent models; only an administrator authors the
 *  instance-wide definitions, and the register that does it is not drawn for anybody else. */
describe('subagent page for an ordinary account', () => {
  it('shows the model pins and no authoring controls', async () => {
    userConfig.current = { ...userConfig.current, config: {} };
    mount();
    expect(await screen.findByText(strings.pinsTitle!)).toBeInTheDocument();
    expect(pickerFor('explore')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: strings.add })).toBeNull();
    // Nothing that belongs to an author: no agent prompt editor anywhere on the page.
    expect(screen.queryByPlaceholderText(strings.bodyPlaceholder!)).toBeNull();
  });

  it('gives an administrator the authoring register beside the same pins', async () => {
    me.current = { id: 1, username: 'root', is_admin: true };
    userConfig.current = { ...userConfig.current, config: {} };
    mount();
    expect(await screen.findByText(strings.pinsTitle!)).toBeInTheDocument();
    expect((await screen.findAllByRole('button', { name: strings.add })).length).toBeGreaterThan(0);
    expect(await screen.findByText('triage')).toBeInTheDocument();
  });
});
