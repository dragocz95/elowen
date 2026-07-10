import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PluginInfo, MarketplaceEntry } from '../../../lib/types';

const usePlugins = vi.hoisted(() => vi.fn());
const useMarketplace = vi.hoisted(() => vi.fn());
const toggleMutate = vi.hoisted(() => vi.fn());
const installMutate = vi.hoisted(() => vi.fn());
const updateMutate = vi.hoisted(() => vi.fn());
const uninstallMutate = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries', () => ({ usePlugins, useMarketplace }));
vi.mock('../../../lib/mutations', () => ({
  useTogglePlugin: () => ({ mutate: toggleMutate, isPending: false, variables: undefined }),
  useInstallPlugin: () => ({ mutate: installMutate, isPending: false }),
  useUpdatePlugin: () => ({ mutate: updateMutate, isPending: false }),
  useUninstallPlugin: () => ({ mutate: uninstallMutate, isPending: false }),
  useRestorePlugin: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { PluginsSection } from '../../../modules/settings/PluginsSection';

const plugin = (over: Partial<PluginInfo>): PluginInfo => ({
  name: 'files', version: '1.0.0', description: 'File tools', provides: { tools: ['read'] },
  source: 'bundled', enabled: true, configurable: false, ...over,
});
const entry = (over: Partial<MarketplaceEntry>): MarketplaceEntry => ({
  name: 'weather', version: '1.0.0', description: 'Weather tools', status: 'available', ...over,
});

const renderSection = () => render(<LanguageProvider><PluginsSection /></LanguageProvider>);

describe('PluginsSection catalog', () => {
  beforeEach(() => {
    usePlugins.mockReset(); useMarketplace.mockReset();
    toggleMutate.mockReset(); installMutate.mockReset(); updateMutate.mockReset(); uninstallMutate.mockReset();
    useMarketplace.mockReturnValue({ data: { plugins: [] }, isLoading: false });
  });

  it('renders a card per installed plugin with the category filter', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'files' }), plugin({ name: 'discord', provides: { platforms: ['discord'] } })], isLoading: false });
    renderSection();
    expect(screen.getByText('files')).toBeInTheDocument();
    expect(screen.getByText('discord')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.plugins.catAll })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: en.plugins.catPlatforms })).toBeInTheDocument();
  });

  it('filters the grid by the search query and shows the no-matches empty state', () => {
    usePlugins.mockReturnValue({ data: [plugin({ name: 'files' }), plugin({ name: 'discord', provides: { platforms: ['discord'] } })], isLoading: false });
    renderSection();
    fireEvent.change(screen.getByPlaceholderText(en.plugins.searchPlaceholder), { target: { value: 'disc' } });
    expect(screen.queryByText('files')).not.toBeInTheDocument();
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
