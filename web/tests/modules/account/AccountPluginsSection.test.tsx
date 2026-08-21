import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { PluginUserConfig } from '../../../lib/types';

const save = vi.fn(async (_v: { name: string; values: Record<string, unknown> }) => ({}));
vi.mock('../../../lib/mutations', () => ({
  useSaveMyPluginConfig: () => ({ mutateAsync: save }),
  useSavePluginConfig: () => ({ mutateAsync: vi.fn() }),
}));

const state = vi.hoisted(() => ({ error: false, data: [] as unknown[] }));
const mocks = vi.hoisted(() => ({ refetch: vi.fn() }));
vi.mock('../../../lib/queries', () => ({
  useMyPluginConfigs: () => (state.error
    ? { data: undefined, isLoading: false, isError: true, refetch: mocks.refetch }
    : { data: state.data, isLoading: false, isError: false }),
  useBrainModels: () => ({ data: [] }),
}));

import { AccountPluginsSection } from '../../../modules/account/AccountPluginsSection';

const CRM: PluginUserConfig = {
  name: 'crmdemo',
  description: 'CRM',
  userConfigSchema: [
    { key: 'apiKey', label: 'API key', type: 'secret' },
    { key: 'region', label: 'Region', type: 'string' },
  ],
  config: { region: 'cz' },
  secretsSet: ['apiKey'],
};

const renderSection = () => render(<ToastProvider><AccountPluginsSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => { save.mockClear(); state.error = false; state.data = [CRM]; mocks.refetch.mockClear(); });

describe('AccountPluginsSection', () => {
  it('shows a retryable error instead of a permanent skeleton', () => {
    state.error = true;
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it('says so plainly when no plugin asks the account for anything', () => {
    state.data = [];
    renderSection();
    expect(screen.getByText(/needs details of your own/i)).toBeInTheDocument();
  });

  it('renders every declared field, whatever tab the settings workspace would have put it on', () => {
    renderSection();
    // A secret lands on the instance page's Setup tab and a plain string on Behavior; a per-account form
    // has no tabs, so showing only one of them would hide half the fields with no way to reach them.
    expect(screen.getByText('API key')).toBeInTheDocument();
    expect(screen.getByText('Region')).toBeInTheDocument();
    expect(screen.getByDisplayValue('cz')).toBeInTheDocument();
  });

  it('marks a stored secret as set without ever receiving its value', () => {
    const { container } = renderSection();
    // The daemon sends only `secretsSet`, so the field reports the stored value without inventing one.
    expect(screen.getByText('Stored')).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(container.querySelector('input[type="password"]')).toHaveValue('');
  });

  it('autosaves an edit to the account\'s own values, not to the instance config', async () => {
    renderSection();
    fireEvent.change(screen.getByDisplayValue('cz'), { target: { value: 'sk' } });
    await waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 3000 });
    expect(save.mock.calls[0]![0]).toEqual({ name: 'crmdemo', values: { region: 'sk' } });
  });
});
