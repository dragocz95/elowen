import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ThemeProvider } from '../../../lib/useTheme';
import { EffectsProvider } from '../../../lib/useEffects';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PluginDetail as PluginDetailData, PluginConfigField, PluginInfo } from '../../../lib/types';

const usePluginDetail = vi.hoisted(() => vi.fn());
const usePluginContributions = vi.hoisted(() => vi.fn());
const usePluginLogs = vi.hoisted(() => vi.fn());
const usePluginHookExecutions = vi.hoisted(() => vi.fn());
const usePlugins = vi.hoisted(() => vi.fn());
const useProjects = vi.hoisted(() => vi.fn());
const useConfig = vi.hoisted(() => vi.fn());
const useBrainModels = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries', () => ({ usePluginDetail, usePluginContributions, usePluginLogs, usePluginHookExecutions, usePlugins, useProjects, useConfig, useBrainModels }));
vi.mock('../../../lib/mutations', () => ({
  useSavePluginConfig: () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: false }),
  useTogglePlugin: () => ({ mutate: vi.fn(), isPending: false }),
  useClearPluginData: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PluginDetail } from '../../../modules/settings/PluginDetail';

const detail = (configSchema: PluginConfigField[], config: Record<string, unknown>, name = 'testy'): PluginDetailData => ({
  name, version: '1.0.0', description: 'Test plugin', provides: { tools: [] },
  source: 'user', enabled: true, configurable: true,
  configSchema, config, secretsSet: [],
  data: { path: '', exists: false, files: 0, bytes: 0 },
});

const plugin = (over: Partial<PluginInfo>): PluginInfo => ({
  name: 'discord', version: '1.0.0', description: '', provides: {},
  source: 'bundled', enabled: true, configurable: false, ...over,
});

const renderDetail = () => {
  render(<EffectsProvider><ThemeProvider><LanguageProvider><PluginDetail name="testy" onBack={() => {}} /></LanguageProvider></ThemeProvider></EffectsProvider>);
};

beforeEach(() => {
  usePluginDetail.mockReset(); usePlugins.mockReset();
  usePluginContributions.mockReturnValue({ data: undefined });
  usePluginLogs.mockReturnValue({ data: undefined });
  usePluginHookExecutions.mockReturnValue({ data: undefined });
  useProjects.mockReturnValue({ data: [] });
  useConfig.mockReturnValue({ data: undefined });
  usePlugins.mockReturnValue({ data: [] });
  useBrainModels.mockReturnValue({ data: [] });
});

describe('PluginDetail model field', () => {
  it('uses the shared searchable provider modal for brain models', async () => {
    useBrainModels.mockReturnValue({ data: [
      { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth' },
    ] });
    usePluginDetail.mockReturnValue({ data: detail([{ key: 'visionModel', label: 'Vision model', type: 'model', hint: 'Used for images.' }], { visionModel: 'elowen:anthropic/claude-opus' }), isLoading: false });
    renderDetail();
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    expect(screen.getByRole('searchbox', { name: en.managePicker.searchPlaceholder })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Anthropic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'claude-opus' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('PluginDetail workspace', () => {
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
    expect(screen.queryByText(en.pluginDetail.overviewStatus)).not.toBeInTheDocument();
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
      { rolePolicies: [{ roleId: '1', name: 'dev', projectIds: [], prompt: '', tools: [] }] },
    ), isLoading: false });
    renderDetail();

    fireEvent.click(screen.getByText('dev'));
    const allTools = screen.getByText(en.pluginCfg.roleToolsAll);
    await waitFor(() => expect(allTools).toBeVisible());

    fireEvent.click(screen.getByRole('radio', { name: en.pluginDetail.tabCapabilities }));
    await waitFor(() => expect(allTools).not.toBeVisible());

    fireEvent.click(screen.getByRole('radio', { name: en.pluginDetail.tabBehavior }));
    await waitFor(() => expect(allTools).toBeVisible());
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

describe('PluginDetail config density', () => {
  const schema: PluginConfigField[] = [
    { key: 'sec_behavior', label: 'Behavior', type: 'section', hint: 'How this plugin behaves.' },
    { key: 'enabled', label: 'Enabled', type: 'boolean', hint: 'A longer explanation that should stay behind the help affordance.' },
  ];

  it('keeps section and field explanations out of the layout until the shared HelpTip is focused', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { enabled: true }), isLoading: false });
    renderDetail();
    expect(screen.getAllByText('Behavior')).toHaveLength(2); // workspace tab + manifest section heading
    expect(screen.queryByText('How this plugin behaves.')).toBeNull();
    expect(screen.queryByText('A longer explanation that should stay behind the help affordance.')).toBeNull();

    const helpButtons = screen.getAllByRole('button', { name: en.common.help });
    expect(helpButtons.length).toBeGreaterThanOrEqual(2);
    fireEvent.focus(helpButtons.at(-1)!);
    expect(screen.getByText('A longer explanation that should stay behind the help affordance.')).toBeInTheDocument();
  });
});

describe('PluginDetail per-role tool allowlist', () => {
  const schema: PluginConfigField[] = [{ key: 'rolePolicies', label: 'Roles', type: 'rolePolicies' }];
  const role = (tools: string[]) => [{ roleId: '1', name: 'dev', projectIds: [], prompt: '', tools }];

  beforeEach(() => {
    usePlugins.mockReturnValue({
      data: [
        plugin({ name: 'discord', hasIcon: true, provides: { tools: ['discord_send'] } }), // ships a brand icon
        plugin({ name: 'web', provides: { tools: ['web_search'] } }), // no icon → lucide fallback glyph
        plugin({ name: 'off', enabled: false, provides: { tools: ['off_tool'] } }), // disabled → not in the vocabulary
      ],
    });
  });

  const expandRole = () => fireEvent.click(screen.getByText('dev'));

  it('empty selection keeps the "all tools" semantics in summary and modal footer', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { rolePolicies: role([]) }), isLoading: false });
    renderDetail();
    expandRole();
    expect(screen.getByText(en.pluginCfg.roleToolsAll)).toBeInTheDocument(); // summary
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    // Footer shows the empty-selection hint too (summary + footer).
    expect(screen.getAllByText(en.pluginCfg.roleToolsAll)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'off_tool' })).toBeNull();
  });

  it('groups the vocabulary by owning plugin and saving updates the summary', async () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { rolePolicies: role([]) }), isLoading: false });
    renderDetail();
    expandRole();
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    const discordHeading = screen.getByRole('heading', { name: 'discord' });
    expect(discordHeading).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'web' })).toBeInTheDocument();
    // Every group and tool row uses the same monochrome Lucide icon system, including plugins that
    // ship an external brand asset.
    expect(discordHeading.querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'web' }).querySelector('svg')).toBeTruthy();
    const toolRow = screen.getByRole('button', { name: 'discord_send' });
    expect(toolRow.querySelector('svg')).toBeTruthy();
    fireEvent.click(toolRow);
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));
    await waitFor(() => expect(screen.queryByRole('button', { name: en.managePicker.saveChanges })).toBeNull());
    expect(screen.getByText('1 tools selected')).toBeInTheDocument();
    expect(screen.getByText('discord_send')).toBeInTheDocument(); // sample chip
  });

  it('a saved tool no longer contributed by any enabled plugin stays visible as a pinned row', () => {
    usePluginDetail.mockReturnValue({ data: detail(schema, { rolePolicies: role(['ghost_tool']) }), isLoading: false });
    renderDetail();
    expandRole();
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    expect(screen.getByRole('button', { name: 'ghost_tool' })).toHaveAttribute('aria-pressed', 'true');
  });
});
