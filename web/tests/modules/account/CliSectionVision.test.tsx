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
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '',
  autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', personalityBody: '', discordUserId: '', whatsappNumber: '',
  autoRecall: true, autoSave: true,
};
const PERMISSIONS: PermissionSettings = { tools: {}, bash: {}, yolo: false, unattendedAsks: 'allow' };
const MODELS: BrainModelOption[] = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus', exec: 'elowen:anthropic/claude-opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
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

describe('CliSection — vision fallback model picker', () => {
  it('seeds on "No fallback model" and offers the manage summary', () => {
    renderSection();
    expect(screen.getByText(en.cli.visionModelLabel)).toBeTruthy();
    // The vision summary chip shows the default (off) label until a model is picked.
    expect(screen.getByText(en.cli.visionModelDefault)).toBeTruthy();
    expect(screen.getByRole('button', { name: en.managePicker.manage })).toBeTruthy();
  });

  it('picking a model in the modal groups by provider (with icons) and autosaves provider::model', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.manage }));
    // Provider group header carries its brand logo; the model row its own model icon.
    const heading = await screen.findByRole('heading', { name: 'Anthropic' });
    expect(heading.querySelector('img')).toBeTruthy();
    const row = screen.getByRole('button', { name: 'claude-opus' });
    expect(row.querySelector('img')).toBeTruthy();
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: en.managePicker.saveChanges }));

    await waitFor(() => expect(saveCli).toHaveBeenCalled(), { timeout: 1500 });
    expect(saveCli.mock.calls[0]![0]).toMatchObject({ visionModel: 'claude-opus', visionModelProvider: 'anthropic' });
  });
});
