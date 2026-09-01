import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PluginInfo, MarketplaceEntry } from '../../../lib/types';
import { EffectsProvider } from '../../../lib/useEffects';
import { SettingsDocument } from '../../../components/ui/SettingsSurface';

const usePlugins = vi.hoisted(() => vi.fn());
const useMarketplace = vi.hoisted(() => vi.fn());
const toggleMutate = vi.hoisted(() => vi.fn());
const installMutate = vi.hoisted(() => vi.fn());
const updateMutate = vi.hoisted(() => vi.fn());
const uninstallMutate = vi.hoisted(() => vi.fn());
const asAsync = vi.hoisted(() => (mutate: any) => (value: unknown) => new Promise((resolve, reject) => {
  mutate(value, { onSuccess: resolve, onError: reject });
}));
vi.mock('../../../lib/queries', () => ({ usePlugins, useMarketplace }));
vi.mock('../../../lib/mutations', () => ({
  useTogglePlugin: () => ({ mutate: toggleMutate, mutateAsync: asAsync(toggleMutate), isPending: false, variables: undefined }),
  useInstallPlugin: () => ({ mutate: installMutate, mutateAsync: asAsync(installMutate), isPending: false, variables: undefined }),
  useUpdatePlugin: () => ({ mutate: updateMutate, isPending: false }),
  useUninstallPlugin: () => ({ mutate: uninstallMutate, isPending: false }),
  useRestorePlugin: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PluginsSection } from '../../../modules/settings/PluginsSection';
import { ElowenApiError } from '../../../lib/elowenClient';

const plugin = (over: Partial<PluginInfo>): PluginInfo => ({
  name: 'files', version: '1.0.0', description: 'File tools', provides: { tools: ['read'] },
  source: 'bundled', enabled: true, configurable: false, ...over,
});
const entry = (over: Partial<MarketplaceEntry>): MarketplaceEntry => ({
  name: 'weather', version: '1.0.0', description: 'Weather tools', status: 'available', ...over,
});

const renderSection = () => render(<EffectsProvider><LanguageProvider><SettingsDocument><PluginsSection /></SettingsDocument></LanguageProvider></EffectsProvider>);

describe('PluginsSection catalog', () => {
  beforeEach(() => {
    usePlugins.mockReset(); useMarketplace.mockReset();
    toggleMutate.mockReset(); installMutate.mockReset(); updateMutate.mockReset(); uninstallMutate.mockReset();
    useMarketplace.mockReturnValue({ data: { plugins: [] }, isLoading: false });
  });

  it('renders one compact row per installed plugin', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'files' }), plugin({ name: 'discord', provides: { platforms: ['discord'] } })], isLoading: false });
    renderSection();
    expect(screen.getByText('files')).toBeInTheDocument();
    expect(screen.getByText('discord')).toBeInTheDocument();
    expect(screen.getByTestId('installed-plugins-list')).toHaveAttribute('role', 'list');
    expect(screen.getByTestId('installed-plugins-list').children).toHaveLength(2);
  });

  it('keeps search and the installed/available switch in the row and folds the category axis behind the filter control', async () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'files' }), plugin({ name: 'discord', provides: { platforms: ['discord'] } })], isLoading: false });
    renderSection();

    // Visible: the two controls every visit uses.
    expect(screen.getByLabelText(en.plugins.searchPlaceholder)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.plugins.tabInstalled })).toBeInTheDocument();
    // Behind the shared filter control, not in the row.
    expect(screen.queryByRole('radio', { name: en.plugins.catPlatforms })).toBeNull();

    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    expect(await screen.findByRole('radio', { name: en.plugins.catAll })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: en.plugins.catPlatforms }));

    // A narrowing filter announces itself as a chip that names the axis and can undo it.
    const chips = await screen.findByTestId('page-filter-chips');
    expect(within(chips).getByText(`${en.memory.categoryFilter}: ${en.plugins.catPlatforms}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('installed-plugins-list').children).toHaveLength(1));

    fireEvent.click(within(chips).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('installed-plugins-list').children).toHaveLength(2));
    expect(screen.queryByTestId('page-filter-chips')).toBeNull();
  });

  it('uses the shared settings document, group and canonical page toolbar grammar', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'files' })], isLoading: false });
    const { container } = renderSection();
    expect(container.querySelectorAll('[data-settings-document]')).toHaveLength(1);
    expect(container.querySelector('[data-settings-group]')).toBeInTheDocument();
    expect(container.querySelector('.page-toolbar')).toBeInTheDocument();
    expect(container.querySelector('.settings-toolbar')).not.toBeInTheDocument();
    expect(container.querySelector('.page-frame')).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="installed-plugins-list"]')).not.toHaveClass('border-y');
  });

  it('keeps tools, skills and platforms together until the row itself is genuinely narrow', () => {
    usePlugins.mockReturnValue({ data: [plugin({
      name: 'full',
      provides: { tools: ['one', 'two'], skills: ['guide'], platforms: ['chat'] },
    })], isLoading: false });
    const { container } = renderSection();
    expect(container.querySelector('.max-w-\\[18rem\\]')).not.toBeInTheDocument();
    for (const badge of container.querySelectorAll('.font-mono.rounded-md')) expect(badge).toHaveClass('whitespace-nowrap');
  });

  it('filters the list by the search query and shows the no-matches empty state', async () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'files' }), plugin({ name: 'discord', provides: { platforms: ['discord'] } })], isLoading: false });
    renderSection();
    fireEvent.change(screen.getByPlaceholderText(en.plugins.searchPlaceholder), { target: { value: 'disc' } });
    await waitFor(() => expect(screen.queryByText('files')).not.toBeInTheDocument());
    expect(screen.getByText('discord')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(en.plugins.searchPlaceholder), { target: { value: 'zzz' } });
    expect(screen.getByText(en.plugins.noMatches)).toBeInTheDocument();
  });

  it('surfaces the error health badge for an unhealthy plugin', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'web', health: 'error' })], isLoading: false });
    renderSection();
    expect(screen.getByText(en.plugins.healthError)).toBeInTheDocument();
  });

  it('shows the update button when the registry has a newer version of an installed user plugin', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'weather', source: 'user' })], isLoading: false });
    useMarketplace.mockReturnValue({ data: { plugins: [entry({ name: 'weather', status: 'updateAvailable' })] }, isLoading: false });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: `weather: ${en.common.actions}` }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: en.plugins.update }));
    expect(updateMutate).toHaveBeenCalledWith('weather', expect.anything());
  });

  it('right-click on a user plugin opens a management menu with uninstall', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'weather', source: 'user' })], isLoading: false });
    renderSection();
    fireEvent.contextMenu(screen.getByText('weather'));
    // The floating menu is a role=menu; its Uninstall item fires the confirm flow.
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByText(en.plugins.uninstall));
    const confirm = screen.getAllByRole('button', { name: en.plugins.uninstall }).at(-1)!;
    fireEvent.click(confirm);
    expect(uninstallMutate).toHaveBeenCalledWith('weather', expect.anything());
  });

  it('confirms then uninstalls a user plugin', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'weather', source: 'user' })], isLoading: false });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: `weather: ${en.common.actions}` }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: en.plugins.uninstall }));
    // Confirm dialog → the destructive confirm button fires the mutation.
    const confirm = screen.getAllByRole('button', { name: en.plugins.uninstall }).at(-1)!;
    fireEvent.click(confirm);
    expect(uninstallMutate).toHaveBeenCalledWith('weather', expect.anything());
  });
});

describe('PluginsSection available view', () => {
  beforeEach(() => {
    usePlugins.mockReset(); useMarketplace.mockReset();
    installMutate.mockReset();
    usePlugins.mockReturnValue({ data: [], isLoading: false });
  });

  it('lists available plugins and installs one', () => {
    useMarketplace.mockReturnValue({ data: { plugins: [entry({ name: 'weather' })] }, isLoading: false });
    renderSection();
    fireEvent.click(screen.getByRole('radio', { name: en.plugins.tabAvailable }));
    expect(screen.getByText('weather')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.plugins.install }));
    expect(installMutate).toHaveBeenCalledWith({ name: 'weather' }, expect.anything());
  });

  it('shows the registry-error empty state', () => {
    useMarketplace.mockReturnValue({ data: { plugins: [], registryError: 'offline' }, isLoading: false });
    renderSection();
    fireEvent.click(screen.getByRole('radio', { name: en.plugins.tabAvailable }));
    expect(screen.getByText(en.plugins.marketplaceError)).toBeInTheDocument();
  });
});

describe('PluginsSection grant consent', () => {
  beforeEach(() => {
    usePlugins.mockReset(); useMarketplace.mockReset(); toggleMutate.mockReset();
    useMarketplace.mockReturnValue({ data: { plugins: [] }, isLoading: false });
    usePlugins.mockReturnValue({ data: [plugin({ name: 'risky', enabled: false })], isLoading: false });
  });

  // The daemon refuses an enable whose grants are unacknowledged (409 + the list). The UI must turn that
  // refusal into the question it is, and must send back what the daemon named — never a list of its own,
  // or a build that predates a new grant would consent to something it never displayed.
  const refuseOnce = (grants: string[]) => toggleMutate.mockImplementationOnce((_v: unknown, o: { onError?: (e: unknown) => void }) => {
    o.onError?.(new ElowenApiError('elowen 409 on /plugins/risky', 409, 'grants require consent', { grants }));
  });

  it('asks before handing over declared powers and replays the enable with the acknowledgement', async () => {
    refuseOnce(['memory', 'workflow-dag']);
    renderSection();
    fireEvent.click(screen.getByLabelText(`risky: ${en.plugins.enable}`));

    expect(await screen.findByText(en.plugins.grantsTitle.replace('{name}', 'risky'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.plugins.grantMemory))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.plugins.grantWorkflowDag))).toBeInTheDocument();
    expect(toggleMutate).toHaveBeenCalledTimes(1);
    expect(toggleMutate.mock.calls[0][0]).toEqual({ name: 'risky', enabled: true });

    fireEvent.click(screen.getByRole('button', { name: en.plugins.grantsConfirm }));
    await waitFor(() => expect(toggleMutate).toHaveBeenCalledTimes(2));
    expect(toggleMutate.mock.calls[1][0]).toEqual({ name: 'risky', enabled: true, acknowledgeGrants: ['memory', 'workflow-dag'] });
  });

  it('shows a grant it does not have a translation for rather than dropping it from the list', async () => {
    refuseOnce(['telepathy']);
    renderSection();
    fireEvent.click(screen.getByLabelText(`risky: ${en.plugins.enable}`));
    expect(await screen.findByText(/telepathy/)).toBeInTheDocument();
  });

  it('locks the consent action against duplicate submissions', async () => {
    refuseOnce(['tools']);
    renderSection();
    fireEvent.click(screen.getByLabelText(`risky: ${en.plugins.enable}`));
    const confirm = await screen.findByRole('button', { name: en.plugins.grantsConfirm });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(toggleMutate).toHaveBeenCalledTimes(2));
  });

  it('leaves the plugin off when the operator declines', async () => {
    refuseOnce(['memory']);
    renderSection();
    fireEvent.click(screen.getByLabelText(`risky: ${en.plugins.enable}`));
    fireEvent.click(await screen.findByRole('button', { name: en.common.cancel }));

    await waitFor(() => expect(screen.queryByText(en.plugins.grantsTitle.replace('{name}', 'risky'))).not.toBeInTheDocument());
    expect(toggleMutate).toHaveBeenCalledTimes(1);
  });
});

describe('PluginsSection install consent', () => {
  beforeEach(() => {
    usePlugins.mockReset(); useMarketplace.mockReset(); installMutate.mockReset();
    usePlugins.mockReturnValue({ data: [], isLoading: false });
    useMarketplace.mockReturnValue({ data: { plugins: [entry({ name: 'risky' })] }, isLoading: false });
  });

  // One-click install used to enable by default and ask nothing — the way around the whole gate.
  it('asks before a marketplace install switches declared powers on, and replays the install', async () => {
    installMutate.mockImplementationOnce((_v: unknown, o: { onError?: (e: unknown) => void }) => {
      o.onError?.(new ElowenApiError('elowen 409', 409, 'grants require consent', { grants: ['tools'], installed: true }));
    });
    renderSection();
    fireEvent.click(screen.getByRole('radio', { name: en.plugins.tabAvailable }));
    fireEvent.click(screen.getByRole('button', { name: en.plugins.install }));

    expect(await screen.findByText(new RegExp(en.plugins.grantTools))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.plugins.grantsConfirm }));
    await waitFor(() => expect(installMutate).toHaveBeenCalledTimes(2));
    expect(installMutate.mock.calls[1][0]).toEqual({ name: 'risky', acknowledgeGrants: ['tools'] });
  });
});
