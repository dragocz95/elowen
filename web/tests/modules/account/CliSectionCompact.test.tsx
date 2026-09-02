import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { CliSettings, PermissionSettings, BrainModelOption } from '../../../lib/types';

const saveCli = vi.fn();
const savePermissions = vi.fn();
vi.mock('../../../lib/mutations', () => ({
  useSaveMyCliSettings: () => ({ mutate: saveCli, mutateAsync: saveCli }),
  useSaveMyPermissions: () => ({ mutate: savePermissions, mutateAsync: savePermissions }),
}));

const CLI: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: '',
  autoCompact: false, autoCompactAt: 80, autoCompactAtByModel: {}, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '',
  autoRecall: true, autoLiveRecall: true, autoSave: true,
};
const PERMISSIONS: PermissionSettings = { tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' };
// `default: true` is what the daemon marks as the model the spawn path resolves, so an unset primary
// resolves to k3 — which is the model the compaction row must then name in its inherit label.
const MODELS: BrainModelOption[] = [
  { provider: 'kimi-coding', providerLabel: 'Kimi', model: 'k3', exec: 'elowen:kimi-coding/k3', source: 'oauth', contextWindow: 200000, contextWindowSet: false, default: true },
];
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMe: () => ({ data: { user: { id: 2, is_admin: false, allowed_execs: [] } } }),
  useMyCliSettings: () => ({ data: CLI, isLoading: false }),
  useMyPermissions: () => ({ data: PERMISSIONS, isLoading: false }),
  useBrainModels: () => ({ data: MODELS }),
}));

import { CliSection } from '../../../modules/account/CliSection';
import { interpolate } from '../../../lib/i18n';

const renderSection = () => render(<ToastProvider><CliSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => { saveCli.mockClear(); savePermissions.mockClear(); });

describe('CliSection — compaction model picker', () => {
  // MOVED with the control from the Elowen AI card into Account → Models → Model roles. The row still
  // renders with auto-compact off (manual /compact uses it too); what changed is that its unset state
  // now NAMES the primary model it inherits instead of saying "Conversation model".
  it('renders even with auto-compact off and names the primary model it inherits', () => {
    renderSection();
    expect(screen.getByText(en.cli.compactModelLabel)).toBeTruthy();
    expect(screen.getByRole('button', { name: `${en.managePicker.manage}: ${en.cli.compactModelLabel}` }))
      .toHaveTextContent(interpolate(en.settings.modelRoles.inherit, { model: 'k3' }));
    expect(screen.getAllByText(en.settings.modelRoles.inherited).length).toBeGreaterThan(0);
  });

  it('picking a model autosaves compactModel/compactModelProvider as provider::model', async () => {
    renderSection();
    // Its own Manage button (distinct from the vision picker's) opens the compaction-model modal.
    fireEvent.click(screen.getByRole('button', { name: `${en.managePicker.manage}: ${en.cli.compactModelLabel}` }));
    const row = await screen.findByRole('button', { name: 'k3' });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(saveCli).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveCli.mock.calls[0]![0]).toMatchObject({ compactModel: 'k3', compactModelProvider: 'kimi-coding' });
  });
});
