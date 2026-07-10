import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ThemeProvider } from '../../../lib/useTheme';
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
  useSavePluginConfig: () => ({ mutate: vi.fn(), isPending: false }),
  useTogglePlugin: () => ({ mutate: vi.fn(), isPending: false }),
  useClearPluginData: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PluginDetail } from '../../../modules/settings/PluginDetail';

const detail = (configSchema: PluginConfigField[], config: Record<string, unknown>): PluginDetailData => ({
  name: 'testy', version: '1.0.0', description: 'Test plugin', provides: { tools: [] },
  source: 'user', enabled: true, configurable: true,
  configSchema, config, secretsSet: [],
  data: { path: '', exists: false, files: 0, bytes: 0 },
});

const plugin = (over: Partial<PluginInfo>): PluginInfo => ({
  name: 'discord', version: '1.0.0', description: '', provides: {},
  source: 'bundled', enabled: true, configurable: false, ...over,
});

const renderDetail = () => {
  render(<ThemeProvider><LanguageProvider><PluginDetail name="testy" onBack={() => {}} /></LanguageProvider></ThemeProvider>);
  // The generated Config collapsible is closed by default (no unset required secret) — open it.
  fireEvent.click(screen.getByRole('button', { name: en.pluginDetail.config }));
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
    expect(screen.getByText('Behavior')).toBeInTheDocument();
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
    // Group headers carry the owning plugin's icon: discord ships a brand icon (<img>), web falls back
    // to a lucide glyph (<svg>). Each tool row carries its owning plugin's icon too.
    expect(discordHeading.querySelector('img')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'web' }).querySelector('svg')).toBeTruthy();
    const toolRow = screen.getByRole('button', { name: 'discord_send' });
    expect(toolRow.querySelector('img')).toBeTruthy();
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
