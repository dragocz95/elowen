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
vi.mock('../../../lib/queries', () => ({ usePluginDetail, usePluginContributions, usePluginLogs, usePluginHookExecutions, usePlugins, useProjects, useConfig, useBrainModels, useUsers, useNotificationDestinations }));
vi.mock('../../../lib/mutations', () => ({
  useSavePluginConfig: () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: false }),
  useTogglePlugin: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useInstallPlugin: () => ({ mutate: vi.fn(), isPending: false }),
  useClearPluginData: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

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

beforeEach(() => {
  // A workspace tab switch stamps the tab into window.location.hash, which PluginDetail reads back on
  // mount — clear it so a test that ends on a non-default tab can't pin the next test's initial tab.
  window.history.replaceState(null, '', window.location.pathname);
  usePluginDetail.mockReset(); usePlugins.mockReset();
  usePluginContributions.mockReturnValue({ data: undefined });
  usePluginLogs.mockReturnValue({ data: undefined });
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

  it('exposes the five focused workspace tabs and a live preview', () => {
    usePluginDetail.mockReturnValue({ data: detail([], {}), isLoading: false });
    renderDetail();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabSetup })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabBehavior })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabCapabilities })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabActivity })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabAdvanced })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: en.pluginDetail.livePreview })).toBeInTheDocument();
  });

  it('places the live preview in a responsive context rail beside the config document', () => {
    usePluginDetail.mockReturnValue({ data: detail([
      { key: 'message', label: 'Message', type: 'string' },
    ], { message: 'Hello' }), isLoading: false });
    renderDetail();

    const layout = screen.getByTestId('plugin-editor-layout');
    expect(layout).toHaveClass('@4xl:grid-cols-[minmax(0,1fr)_19rem]');
    expect(screen.getByTestId('plugin-preview-rail')).toHaveClass('@4xl:sticky');
    expect(within(layout).getByRole('region', { name: en.pluginDetail.livePreview })).toBeInTheDocument();
    expect(within(layout).getByRole('textbox')).toBeInTheDocument();
    // The old overview "Status" block stays gone from the editor layout.
    expect(screen.queryByText('Status')).not.toBeInTheDocument();
  });

  it('opens Setup first when a required secret is missing', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'token', label: 'Token', type: 'secret', required: true }], {}), isLoading: false });
    renderDetail();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabSetup })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(en.pluginDetail.setupMissing.replace('{n}', '1'))).toBeInTheDocument();
  });

  it('previews Discord per-tool layout and rolling output as separate bubbles', () => {
    usePluginDetail.mockReturnValue({ data: detail([
      { key: 'toolActivity', label: 'Tool activity', type: 'enum', options: [{ value: 'status', label: 'Status' }, { value: 'live', label: 'Live' }] },
      { key: 'toolOutput', label: 'Tool output', type: 'enum', options: [{ value: 'hidden', label: 'Hidden' }, { value: 'summary', label: 'Summary' }, { value: 'tail', label: 'Tail' }] },
      { key: 'toolMessageMode', label: 'Tool layout', type: 'enum', options: [{ value: 'single', label: 'Single' }, { value: 'per_tool', label: 'Per tool' }] },
    ], { toolActivity: 'live', toolOutput: 'tail', toolMessageMode: 'per_tool' }, 'discord'), isLoading: false });
    renderDetail();
    expect(screen.getAllByTestId('discord-tool-bubble')).toHaveLength(2);
    expect(screen.getByText(/\$ npm test/)).toBeInTheDocument();
    expect(screen.getByTestId('discord-preview-layout')).toHaveClass('@lg:grid-cols-[minmax(0,1.35fr)_minmax(0,.65fr)]');
  });

  it('keeps required non-secret fields reachable on Setup', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'workspace', label: 'Workspace', type: 'string', required: true }], {}), isLoading: false });
    renderDetail();
    expect(screen.getByRole('radio', { name: en.pluginDetail.tabSetup })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('keeps terminal informational sections visible', () => {
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'sec_model', label: 'Embedding model', type: 'section', hint: 'Inherited from Settings.' }], {}), isLoading: false });
    renderDetail();
    expect(screen.getByText('Embedding model')).toBeInTheDocument();
  });

  it('retains local editor disclosure state across workspace tab switches', async () => {
    usePluginDetail.mockReturnValue({ data: detail(
      [{ key: 'rolePolicies', label: 'Roles', type: 'rolePolicies' }],
      { rolePolicies: [{ roleId: '1', name: 'dev', prompt: 'Keep it short.', projectIds: [7], tools: ['Bash'], elowenUser: 'legacy' }] },
    ), isLoading: false });
    renderDetail();

    fireEvent.click(screen.getByText('dev'));
    const prompt = screen.getByDisplayValue('Keep it short.');
    await waitFor(() => expect(prompt).toBeVisible());
    expect(screen.queryByText('legacy')).toBeNull();
    expect(screen.queryByText('Bash')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: en.pluginDetail.tabCapabilities }));
    await waitFor(() => expect(prompt).not.toBeVisible());

    fireEvent.click(screen.getByRole('radio', { name: en.pluginDetail.tabBehavior }));
    await waitFor(() => expect(prompt).toBeVisible());
  });
});

describe('PluginDetail config field layout', () => {
  it('gives self-contained controls the full row while keeping plain inputs compact', () => {
    usePluginDetail.mockReturnValue({ data: detail([
      { key: 'destination', label: 'Destination', type: 'destination' },
      { key: 'code', label: 'Code', type: 'code' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
      { key: 'name', label: 'Name', type: 'string' },
    ], {}), isLoading: false });
    renderDetail();

    const fieldWrapper = (label: string) => screen.getAllByText(label).map((node) => node.closest('.animate-fade-up')).find(Boolean);
    for (const label of ['Destination', 'Code', 'Notes']) {
      expect(fieldWrapper(label)).toHaveClass('@lg:col-span-2');
    }
    expect(fieldWrapper('Name')).not.toHaveClass('@lg:col-span-2');
  });
});

describe('PluginDetail secret field', () => {
  it('shows stored status and requires an explicit replace action before editing', () => {
    usePluginDetail.mockReturnValue({ data: detail(
      [{ key: 'token', label: 'Token', type: 'secret' }],
      {},
      'testy',
      ['token'],
    ), isLoading: false });
    const { container } = renderDetail();
    fireEvent.click(screen.getByRole('radio', { name: en.pluginDetail.tabSetup }));

    expect(screen.getByText(en.pluginCfg.secretSet)).toBeInTheDocument();
    expect(screen.getByText(en.pluginCfg.secretKeepHint)).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en.pluginCfg.secretReplace }));
    expect(container.querySelector('input[type="password"]')).toHaveAttribute('placeholder', en.pluginCfg.secretReplacementPlaceholder);
  });
});

describe('PluginDetail multiSelect field', () => {
  const schema: PluginConfigField[] = [
    { key: 'langs', label: 'Languages', type: 'multiSelect', options: [{ value: 'cs', label: 'Czech' }, { value: 'en', label: 'English' }] },
  ];

  it('renders a selection summary and a one-list modal without a group-filter row', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { langs: ['cs'] }), isLoading: false });
    renderDetail();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByText('Czech')).toBeInTheDocument(); // sample chip
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    // Single ungrouped list: no filter chips, no group headers.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Czech|English/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Czech' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('toggling options and saving updates the summary count', async () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { langs: ['cs'] }), isLoading: false });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));
    await waitFor(() => expect(screen.queryByRole('button', { name: en.managePicker.saveChanges })).toBeNull());
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });

  it('a saved value the manifest no longer offers stays visible in the modal', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { langs: ['gone'] }), isLoading: false });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
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
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
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

