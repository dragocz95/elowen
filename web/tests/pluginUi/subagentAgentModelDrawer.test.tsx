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

/** One place per agent: a built-in agent's row opens the register's own detail rail, and the model it
 *  runs on for THIS account is set there — not in a settings panel stacked above the same three names. */

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
afterEach(() => {
  server.resetHandlers();
  saved.body = undefined;
  me.current = MEMBER;
  userConfig.current = { ...userConfig.current, config: {}, revision: 3 };
});
afterAll(() => server.close());

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><SubagentsSettings surface="deck" /></ToastProvider></Wrapper>);
};

const openRow = async (name: string) => {
  fireEvent.click(await screen.findByRole('button', { name: `Open entry: ${name}` }));
};
const anyPicker = new RegExp(`^${strings.pinLabel}: `);

/** The page must not require a plugin UI contract newer than the one the host already publishes. */
describe('subagent page runtime contract', () => {
  it('asks for no runtime version the host does not already publish', () => {
    const required = (manifest as { web: { requiresApiVersion: number } }).web.requiresApiVersion;
    expect(required).toBeLessThanOrEqual(PLUGIN_UI_API_VERSION);
  });

  it('reads and writes the account\'s own settings through the generic query seam, not a hook of its own', () => {
    const hooks = window.ElowenUiRuntime?.hooks as Record<string, unknown> | undefined;
    expect(hooks?.useQuery).toBeTypeOf('function');
    expect(hooks?.useMutation).toBeTypeOf('function');
    expect(hooks?.useUserPluginConfigs).toBeUndefined();
    expect(hooks?.useSaveUserPluginConfig).toBeUndefined();
  });
});

describe('agent model, in the agent\'s own drawer', () => {
  it('has no model panel above the register — the register is the whole page', async () => {
    mount();
    expect(await screen.findByRole('button', { name: 'Open entry: explore' })).toBeInTheDocument();
    // Nothing offers a model before a row is opened: the panel that used to list the same three agents
    // with a picker each is gone, and with it the second place this one setting could be changed.
    expect(screen.queryByRole('button', { name: anyPicker })).toBeNull();
    expect(screen.queryByText(strings.pinHint!)).toBeNull();
  });

  it('opens a built-in agent and states what it is beside the one control the reader owns', async () => {
    mount();
    await openRow('explore');
    const rail = within(await screen.findByRole('dialog'));
    expect(rail.getByText(AGENTS[0]!.description)).toBeInTheDocument();
    expect(rail.getByText(strings.badgeBuiltin!)).toBeInTheDocument();
    expect(rail.getByText(strings.builtinReadOnly!)).toBeInTheDocument();
    expect(rail.getByText(strings.toolsReadOnly!)).toBeInTheDocument();
    // Read-only content, never an editor: a shipped agent's prompt is nobody's to change here.
    expect(rail.queryByRole('textbox')).toBeNull();
    // The picker is live — the catalog is loaded and this account has the plugin's settings slice.
    const trigger = rail.getByRole('button', { name: `${strings.pinLabel}: explore` });
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveTextContent(strings.pinAutomatic!);
  });

  it('picks a model with its brand icon, saves it and shows it when the row is opened again', async () => {
    mount();
    await openRow('explore');
    fireEvent.click(await screen.findByRole('button', { name: `${strings.pinLabel}: explore` }));
    // Two drawers are open now: the agent's rail and the picker on top of it. The picker is the LAST one.
    const dialogs = await screen.findAllByRole('dialog');
    const picker = within(dialogs[dialogs.length - 1]!);
    // Only what this account may run, plus the Automatic choice.
    expect(picker.getByRole('button', { name: strings.pinAutomatic })).toBeInTheDocument();
    fireEvent.click(picker.getByRole('button', { name: 'claude-opus' }));
    fireEvent.click(picker.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(saved.body).toBeTruthy());
    expect(saved.body!.values).toMatchObject({ 'typeModel.explore': 'anthropic/claude-opus' });
    expect(saved.body!.expectedRevision).toBe(3);

    // The row states the saved model and shows its brand mark through the shared ModelIcon rather than a
    // bare id.
    const trigger = await screen.findByRole('button', { name: `${strings.pinLabel}: explore` });
    await waitFor(() => expect(trigger).toHaveTextContent('claude-opus'));
    expect(trigger.querySelector('img, svg')).not.toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openRow('explore');
    expect(await screen.findByRole('button', { name: `${strings.pinLabel}: explore` })).toHaveTextContent('claude-opus');
  });

  it('names a stored model the catalog no longer offers instead of claiming it is active', async () => {
    userConfig.current = { ...userConfig.current, config: { 'typeModel.plan': 'anthropic/retired-model' }, revision: 9 };
    mount();
    await openRow('plan');
    expect(await screen.findByRole('button', { name: `${strings.pinLabel}: plan` })).toHaveTextContent(strings.pinUnavailable!);
  });

  it('says so honestly when the account has no settings slice to save into', async () => {
    server.use(http.get('*/api/plugins/user-config', () => HttpResponse.json([])));
    mount();
    await openRow('explore');
    expect(await screen.findByText(strings.pinsUnavailable!)).toBeInTheDocument();
  });
});

/** Same register, two audiences. Everyone sets their own model; only an administrator authors the shared
 *  definitions, and that form is the SAME drawer — there is never a second model picker. */
describe('the register for each audience', () => {
  it('gives an ordinary account the model drawer and no authoring controls', async () => {
    mount();
    await openRow('explore');
    const rail = within(await screen.findByRole('dialog'));
    expect(rail.getByRole('button', { name: `${strings.pinLabel}: explore` })).toBeInTheDocument();
    expect(rail.queryByRole('button', { name: strings.save })).toBeNull();
    expect(rail.queryByRole('button', { name: strings.remove })).toBeNull();
    expect(screen.queryByRole('button', { name: strings.add })).toBeNull();
    // A custom agent this account may not write does not open at all: there is nothing in it for them.
    expect(screen.queryByRole('button', { name: 'Open entry: triage' })).toBeNull();
  });

  it('keeps the administrator\'s authoring form for a custom agent, with no model picker in it', async () => {
    me.current = { id: 1, username: 'root', is_admin: true };
    mount();
    expect((await screen.findAllByRole('button', { name: strings.add })).length).toBeGreaterThan(0);
    await openRow('triage');
    const form = within(await screen.findByRole('dialog'));
    expect(form.getByRole('button', { name: strings.save })).toBeInTheDocument();
    expect(form.getByDisplayValue('Investigate.')).toBeInTheDocument();
    // The model belongs to the built-in agents' drawer, not to an agent definition.
    expect(form.queryByRole('button', { name: anyPicker })).toBeNull();
  });

  it('gives the administrator the same model drawer on a built-in agent', async () => {
    me.current = { id: 1, username: 'root', is_admin: true };
    mount();
    await openRow('plan');
    const rail = within(await screen.findByRole('dialog'));
    expect(rail.getByRole('button', { name: `${strings.pinLabel}: plan` })).toBeInTheDocument();
    // Built-in content stays read-only for an administrator too.
    expect(rail.queryByRole('textbox')).toBeNull();
    expect(rail.queryByRole('button', { name: strings.remove })).toBeNull();
  });
});
