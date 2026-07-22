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
  autoRecall: true, autoSave: true,
};
const PERMISSIONS: PermissionSettings = { tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' };
const MODELS: BrainModelOption[] = [
  { provider: 'kimi-coding', providerLabel: 'Kimi', model: 'k3', exec: 'elowen:kimi-coding/k3', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
];
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMyCliSettings: () => ({ data: CLI, isLoading: false }),
  useMyPermissions: () => ({ data: PERMISSIONS, isLoading: false }),
  useBrainModels: () => ({ data: MODELS }),
}));

import { CliSection } from '../../../modules/account/CliSection';

const renderSection = () => render(<ToastProvider><CliSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => { saveCli.mockClear(); savePermissions.mockClear(); });

describe('CliSection — compaction model picker', () => {
  it('renders even with auto-compact off (manual /compact uses it too) and seeds on the default label', () => {
    renderSection();
    expect(screen.getByText(en.cli.compactModelLabel)).toBeTruthy();
    // The compaction summary chip shows "Conversation model" until a distinct model is picked.
    expect(screen.getByText(en.cli.compactModelDefault)).toBeTruthy();
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
