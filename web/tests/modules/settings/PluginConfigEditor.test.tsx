import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PluginConfigEditor } from '../../../modules/settings/PluginConfigEditor';
import { usePluginConfigDraft } from '../../../lib/usePluginConfigDraft';
import type { PluginConfigField, RolePolicy } from '../../../lib/types';
import { createWrapper } from '../../test-utils';

const instanceMutation = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/mutations', () => ({ useSavePluginConfig: () => ({ mutateAsync: instanceMutation }) }));
vi.mock('../../../lib/queries', () => ({
  useBrainModels: () => ({ data: [] }),
  useConfig: () => ({ data: undefined }),
  useNotificationDestinations: () => ({ data: [] }),
  usePlugins: () => ({ data: [] }),
  usePluginTools: () => ({ data: [] }),
  useProjects: () => ({ data: [] }),
}));

const field: PluginConfigField = { key: 'rolePolicies', label: 'Role policies', type: 'rolePolicies' };
const role: RolePolicy = { roleId: 'support', name: 'Support', prompt: '', admin: true };
type Save = (value: { name: string; values: Record<string, unknown> }) => Promise<unknown>;

function RoleFixture({ save }: { save: Save }) {
  const draft = usePluginConfigDraft(
    'discord',
    { configSchema: [field], config: { rolePolicies: [role] } },
    { save },
  );
  return (
    <PluginConfigEditor
      name="discord"
      detail={{ name: 'discord', configSchema: [field], secretsSet: [] }}
      fieldLabel={(item) => item.label}
      fieldHint={(item) => item.hint}
      fieldOptions={(item) => item.options ?? []}
      riskText={(risk) => risk}
      draft={draft}
      mode="all"
    />
  );
}

function mount(save: Save) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><RoleFixture save={save} /></Wrapper>);
}

function RiskFixture() {
  const schema: PluginConfigField[] = [
    { key: 'accessMode', label: 'Access mode', type: 'enum', risk: 'high', options: [
      { value: 'read_only', label: 'Read only' },
      { value: 'read_write', label: 'Read and write (including delete)' },
    ] },
    { key: 'enabled', label: 'Enabled', type: 'boolean' },
  ];
  const draft = usePluginConfigDraft(
    'raynet',
    { configSchema: schema, config: { accessMode: 'read_write', enabled: true } },
    { save: vi.fn<Save>() },
  );
  return (
    <PluginConfigEditor
      name="raynet"
      detail={{ name: 'raynet', configSchema: schema, secretsSet: [] }}
      fieldLabel={(item) => item.label}
      fieldHint={(item) => item.hint}
      fieldOptions={(item) => item.options ?? []}
      riskText={(risk) => risk}
      draft={draft}
      mode="all"
    />
  );
}

async function openRemoval() {
  fireEvent.click(screen.getByRole('button', { name: 'Role policies' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove role' }));
  return screen.getByRole('alertdialog', { name: /Support/ });
}

describe('PluginConfigEditor field layout', () => {
  it('lets a risk badge wrap away from its control instead of overflowing across the label', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><RiskFixture /></Wrapper>);

    expect(screen.getByText('high').closest('.settings-row')).toHaveAttribute('data-trailing', 'stack');
    expect(screen.getByText('high').closest('.settings-row')).toHaveClass('plugin-config-risk-row');
    expect(screen.getByText('Enabled').closest('.settings-row')).toHaveAttribute('data-trailing', 'inline');
  });
});

describe('PluginConfigEditor role policy deletion', () => {
  it('does not mutate before confirmation and preserves the controlled draft on persistence failure', async () => {
    const save = vi.fn<Save>().mockRejectedValue(new Error('request failed'));
    mount(save);

    const dialog = await openRemoval();
    expect(save).not.toHaveBeenCalled();
    expect(dialog).toHaveTextContent('Saving this policy changes platform permissions');

    fireEvent.click(screen.getByRole('button', { name: 'Remove role' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({ name: 'discord', values: { rolePolicies: [] } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(screen.getByRole('alertdialog', { name: /Support/ })).toBeInTheDocument();
    expect(screen.getByText('Support')).toBeInTheDocument();
  });

  it('commits a persisted deletion, closes the dialog and reports pending activation', async () => {
    const save = vi.fn<Save>().mockResolvedValue({ ok: true, pending: true });
    mount(save);
    await openRemoval();

    fireEvent.click(screen.getByRole('button', { name: 'Remove role' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: /Support/ })).toBeNull());
    expect(screen.queryByText('Support')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('was saved');
    expect(screen.getByRole('status')).toHaveTextContent('activation is pending');
  });
});
