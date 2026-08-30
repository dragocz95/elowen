import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ThemeProvider } from '../../../lib/useTheme';
import { EffectsProvider } from '../../../lib/useEffects';
import { SettingsDocument } from '../../../components/ui/SettingsSurface';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PluginDetail as PluginDetailData, PluginConfigField } from '../../../lib/types';

const usePluginDetail = vi.hoisted(() => vi.fn());
const usePluginContributions = vi.hoisted(() => vi.fn());
const usePluginLogs = vi.hoisted(() => vi.fn());
const usePluginHookExecutions = vi.hoisted(() => vi.fn());
const usePlugins = vi.hoisted(() => vi.fn());
const useProjects = vi.hoisted(() => vi.fn());
const useConfig = vi.hoisted(() => vi.fn());
const useBrainModels = vi.hoisted(() => vi.fn());
const useUsers = vi.hoisted(() => vi.fn());
const useNotificationDestinations = vi.hoisted(() => vi.fn());
const useSystemReadiness = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries', () => ({ usePluginDetail, usePluginContributions, usePluginLogs, usePluginHookExecutions, usePlugins, useProjects, useConfig, useBrainModels, useUsers, useNotificationDestinations, useSystemReadiness }));
// The debounced draft writes through this one mutation, so a shared mock is what lets a test prove that
// editing a record — or the editor inside its modal — actually reaches the server.
const savePluginConfig = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/mutations', () => ({
  useSavePluginConfig: () => ({ mutate: savePluginConfig, mutateAsync: savePluginConfig, isPending: false }),
  useTogglePlugin: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useInstallPlugin: () => ({ mutate: vi.fn(), isPending: false }),
  useClearPluginData: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// Monaco is browser-only (web workers) and never mounts under jsdom; stub it with a plain textarea that
// forwards value/onChange so a `code`/`prompt` field stays exercisable.
vi.mock('../../../lib/monaco/monacoLoader', () => ({
  MonacoEditor: ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options?: { ariaLabel?: string } }) => (
    <textarea data-testid="monaco" aria-label={options?.ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  MonacoDiffEditor: () => null,
}));

import { PluginDetail } from '../../../modules/settings/PluginDetail';

const detail = (configSchema: PluginConfigField[], config: Record<string, unknown>, name = 'testy', secretsSet: string[] = []): PluginDetailData => ({
  name, version: '1.0.0', description: 'Test plugin', provides: { tools: [] },
  source: 'user', enabled: true, configurable: true,
  configSchema, config, secretsSet,
  data: { path: '', exists: false, files: 0, bytes: 0 },
});

const renderDetail = () => {
  return render(<EffectsProvider><ThemeProvider><LanguageProvider><SettingsDocument><PluginDetail name="testy" onBack={() => {}} /></SettingsDocument></LanguageProvider></ThemeProvider></EffectsProvider>);
};

/** The record a field owns, found by its label. */
const rowOf = (label: string) => screen.getByText(label).closest('.settings-row') as HTMLElement;

beforeEach(() => {
  // A workspace tab switch stamps the tab into window.location.hash, which PluginDetail reads back on
  // mount — clear it so a test that ends on a non-default tab can't pin the next test's initial tab.
  window.history.replaceState(null, '', window.location.pathname);
  usePluginDetail.mockReset(); usePlugins.mockReset();
  savePluginConfig.mockReset(); savePluginConfig.mockResolvedValue({ ok: true });
  usePluginContributions.mockReturnValue({ data: undefined });
  usePluginLogs.mockReturnValue({ data: undefined });
  useSystemReadiness.mockReturnValue({ data: undefined });
  usePluginHookExecutions.mockReturnValue({ data: undefined });
  useProjects.mockReturnValue({ data: [] });
  useConfig.mockReturnValue({ data: undefined });
  usePlugins.mockReturnValue({ data: [] });
  useBrainModels.mockReturnValue({ data: [] });
  useUsers.mockReturnValue({ data: [] });
  useNotificationDestinations.mockReturnValue({ data: [] });
});

describe('PluginDetail — error state', () => {
  it('shows a retryable error instead of an infinite skeleton', () => {
    const refetch = vi.fn();
    usePluginDetail.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    renderDetail();
    expect(screen.getByRole('button', { name: en.common.retry })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});

describe('PluginDetail model field', () => {
  it('uses the shared searchable provider modal for brain models', async () => {
    useBrainModels.mockReturnValue({ data: [
      { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth' },
    ] });
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'visionModel', label: 'Vision model', type: 'model', hint: 'Used for images.' }], { visionModel: 'elowen:anthropic/claude-opus' }), isLoading: false });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Vision model' }));
    expect(screen.getByRole('searchbox', { name: en.managePicker.searchPlaceholder })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'claude-opus' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('PluginDetail workspace', () => {
  it('uses the shared settings document and group grammar', () => {
    usePluginDetail.mockReturnValue({ data: detail([], {}), isLoading: false });
    const { container } = renderDetail();
    expect(container.querySelectorAll('[data-settings-document]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-settings-group]').length).toBeGreaterThan(0);
    expect(container.querySelector('.settings-toolbar')).toBeInTheDocument();
  });

  it('shows the capability panels inline as settings-group cards (no accordion to expand)', () => {
    usePluginContributions.mockReturnValue({ data: { tools: [{ name: 'DiscordApi' }], skills: [], platforms: [{ name: 'discord' }], hooks: [] } });
    usePluginDetail.mockReturnValue({ data: detail([], {}, 'discord'), isLoading: false });
    renderDetail();
    fireEvent.click(screen.getByRole('radio', { name: en.pluginDetail.tabCapabilities }));
    // The Tools / Hooks / Permissions panels render their content immediately — each is a settings-group
    // card with an icon-chip header, not a collapsed accordion the user must click open first.
    expect(screen.getByText('DiscordApi')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.pluginDetail.tools })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.pluginDetail.hooks })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.pluginDetail.permissions })).toBeInTheDocument();
  });

  it('exposes the five focused workspace tabs', () => {
    usePluginDetail.mockReturnValue({ data: detail([], {}), isLoading: false });
    renderDetail();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabSetup })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabBehavior })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabCapabilities })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabActivity })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabAdvanced })).toBeInTheDocument();
  });

  it('gives the config document the whole width — no live-preview rail beside it', () => {
    usePluginDetail.mockReturnValue({ data: detail([
      { key: 'message', label: 'Message', type: 'string' },
    ], { message: 'Hello' }), isLoading: false });
    renderDetail();

    expect(screen.queryByTestId('plugin-editor-layout')).toBeNull();
    expect(screen.queryByTestId('plugin-preview-rail')).toBeNull();
    expect(screen.queryByRole('region', { name: /preview/i })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Hello');
  });

  it('opens Setup first when a required secret is missing', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'token', label: 'Token', type: 'secret', required: true }], {}), isLoading: false });
    renderDetail();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabSetup })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(en.pluginDetail.setupMissing.replace('{n}', '1'))).toBeInTheDocument();
  });

  it('keeps required non-secret fields reachable on Setup', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'workspace', label: 'Workspace', type: 'string', required: true }], {}), isLoading: false });
    renderDetail();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabSetup })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox', { name: 'Workspace' })).toBeInTheDocument();
  });

  it('keeps terminal informational sections visible', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'sec_model', label: 'Embedding model', type: 'section', hint: 'Inherited from Settings.' }], {}), isLoading: false });
    renderDetail();
    expect(screen.getByText('Embedding model')).toBeInTheDocument();
  });
});

describe('PluginDetail config field layout', () => {
  it('renders every field as a settings record carrying one compact control', () => {
    usePluginDetail.mockReturnValue({ data: detail([
      { key: 'destination', label: 'Destination', type: 'destination' },
      { key: 'code', label: 'Code', type: 'code' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
      { key: 'name', label: 'Name', type: 'string' },
      { key: 'streaming', label: 'Streaming', type: 'boolean' },
    ], {}), isLoading: false });
    const { container } = renderDetail();

    const panel = container.querySelector('[data-plugin-panel="behavior"]') as HTMLElement;
    expect(panel.querySelectorAll('.settings-row')).toHaveLength(5);
    for (const label of ['Destination', 'Code', 'Notes', 'Name', 'Streaming']) {
      expect(rowOf(label).querySelectorAll('.settings-row__control')).toHaveLength(1);
    }
    // The document-shaped fields keep their editor behind the record's trigger instead of expanding the
    // form: the only inline text control left is the plain string input.
    expect(screen.queryByTestId('monaco')).toBeNull();
    expect(within(panel).getAllByRole('textbox')).toHaveLength(1);
    for (const label of ['Code', 'Notes']) {
      expect(within(rowOf(label)).getByRole('button', { name: label })).toHaveAttribute('aria-haspopup', 'dialog');
    }
  });

  it('saves a value edited directly in a record', async () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'streaming', label: 'Streaming', type: 'boolean' }], { streaming: false }), isLoading: false });
    renderDetail();

    fireEvent.click(within(rowOf('Streaming')).getByRole('switch', { name: 'Streaming' }));
    await waitFor(() => expect(savePluginConfig).toHaveBeenCalledWith({ name: 'testy', values: { streaming: true } }), { timeout: 3000 });
  });
});

describe('PluginDetail document-shaped fields', () => {
  it('summarises a text field in its record and saves what the modal editor changes', async () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'notes', label: 'Notes', type: 'textarea' }], { notes: 'one\ntwo' }), isLoading: false });
    renderDetail();

    expect(screen.getByText(en.pluginCfg.editorLines.replace('{n}', '2'))).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Notes' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'one\ntwo\nthree' } });
    await waitFor(() => expect(savePluginConfig).toHaveBeenCalledWith({ name: 'testy', values: { notes: 'one\ntwo\nthree' } }), { timeout: 3000 });
  });

  it('reports an empty document rather than an empty editor', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'prompt', label: 'Prompt', type: 'prompt' }], {}), isLoading: false });
    renderDetail();
    expect(screen.getByText(en.pluginCfg.editorEmpty)).toBeInTheDocument();
    expect(screen.queryByTestId('monaco')).toBeNull();
  });

  it('flags invalid JSON on the record and keeps the editor behind the modal', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'payload', label: 'Payload', type: 'json' }], { payload: '{ nope' }), isLoading: false });
    renderDetail();
    expect(within(rowOf('Payload')).getByRole('alert')).toHaveTextContent(en.pluginCfg.invalidJson);

    fireEvent.click(screen.getByRole('button', { name: 'Payload' }));
    expect(screen.getByRole('textbox', { name: 'Payload' })).toHaveValue('{ nope');
  });

  it('opens the structured roles editor in a modal, ignoring legacy stored fields', async () => {
    usePluginDetail.mockReturnValue({ data: detail(
      [{ key: 'rolePolicies', label: 'Roles', type: 'rolePolicies' }],
      { rolePolicies: [{ roleId: '1', name: 'dev', prompt: 'Keep it short.', projectIds: [7], tools: ['Bash'], elowenUser: 'legacy' }] },
    ), isLoading: false });
    renderDetail();

    expect(screen.getByText(en.pluginCfg.editorItems.replace('{n}', '1'))).toBeInTheDocument();
    expect(screen.queryByText('dev')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Roles' }));
    fireEvent.click(screen.getByText('dev'));
    await waitFor(() => expect(screen.getByDisplayValue('Keep it short.')).toBeVisible());
    expect(screen.queryByText('legacy')).toBeNull();
    expect(screen.queryByText('Bash')).toBeNull();
  });
});

describe('PluginDetail secret field', () => {
  it('reports a stored secret as a compact status and requires an explicit replace action', () => {
    usePluginDetail.mockReturnValue({ data: detail(
      [{ key: 'token', label: 'Token', type: 'secret' }],
      {},
      'testy',
      ['token'],
    ), isLoading: false });
    const { container } = renderDetail();
    fireEvent.click(screen.getByRole('radio', { name: en.pluginDetail.tabSetup }));

    const row = rowOf('Token');
    expect(within(row).getByText(en.pluginCfg.secretSet)).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    // The keep-hint sits behind the record's help affordance instead of adding a second line to it.
    expect(screen.queryByText(en.pluginCfg.secretKeepHint)).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: en.pluginCfg.secretReplace }));
    expect(container.querySelector('input[type="password"]')).toHaveAttribute('placeholder', en.pluginCfg.secretReplacementPlaceholder);
  });
});

describe('PluginDetail multiSelect field', () => {
  const schema: PluginConfigField[] = [
    { key: 'langs', label: 'Languages', type: 'multiSelect', options: [{ value: 'cs', label: 'Czech' }, { value: 'en', label: 'English' }] },
  ];

  it('renders a count trigger and a one-list modal without a group-filter row', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { langs: ['cs'] }), isLoading: false });
    renderDetail();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Languages' }));
    // Single ungrouped list: no filter chips, no group headers.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Czech|English/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Czech' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggling options and saving updates the summary count', async () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { langs: ['cs'] }), isLoading: false });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Languages' }));
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));
    await waitFor(() => expect(screen.queryByRole('button', { name: en.managePicker.saveChanges })).toBeNull());
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('a saved value the manifest no longer offers stays visible in the modal', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { langs: ['gone'] }), isLoading: false });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Languages' }));
    expect(screen.getByRole('button', { name: 'gone' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('PluginDetail destination field', () => {
  it('groups multiple platforms and preserves the opaque routed value', async () => {
    useNotificationDestinations.mockReturnValue({ data: [
      { value: 'destination:discord:100', id: '100', platform: 'discord', kind: 'channel', label: '#general', group: 'Discord' },
      { value: 'msteams:a%3Afilip', id: 'a:filip', platform: 'msteams', kind: 'person', label: 'Filip', group: 'Microsoft Teams · Direct chats' },
    ] });
    usePluginDetail.mockReturnValue({ data: detail(
      [{ key: 'notifyConversationId', label: 'Notification conversation', type: 'destination' }],
      { notifyConversationId: 'destination:discord:100' },
    ), isLoading: false });
    renderDetail();
    expect(screen.getAllByText('#general').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Notification conversation' }));
    expect(screen.getByRole('heading', { name: 'Discord' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Microsoft Teams · Direct chats' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filip' }));
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));
    await waitFor(() => expect(screen.getAllByText('Filip').length).toBeGreaterThan(0));
  });
});

describe('PluginDetail config density', () => {
  const schema: PluginConfigField[] = [
    { key: 'sec_behavior', label: 'Behavior', type: 'section', hint: 'How this plugin behaves.' },
    { key: 'enabled', label: 'Enabled', type: 'boolean', hint: 'A longer explanation that should stay behind the help affordance.' },
  ];

  it('keeps section and field explanations out of the layout until the shared HelpTip is focused', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { enabled: true }), isLoading: false });
    const { container } = renderDetail();
    expect(container.querySelector('.spatial-form-group, .spatial-form-row')).not.toBeInTheDocument();
    expect(container.querySelector('.settings-row')).toBeInTheDocument();
    expect(screen.getAllByText('Behavior')).toHaveLength(2); // workspace tab + manifest section heading
    expect(screen.queryByText('How this plugin behaves.')).toBeNull();
    expect(screen.queryByText('A longer explanation that should stay behind the help affordance.')).toBeNull();

    const helpButtons = screen.getAllByRole('button', { name: en.common.help });
    expect(helpButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.focus(helpButtons.at(-1)!);
    expect(screen.getByText('A longer explanation that should stay behind the help affordance.')).toBeInTheDocument();
  });
});
