import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { CliSettings, PermissionSettings } from '../../../lib/types';

const saveCli = vi.fn();
const savePermissions = vi.fn();
vi.mock('../../../lib/mutations', () => ({
  useSaveMyCliSettings: () => ({ mutate: saveCli }),
  useSaveMyPermissions: () => ({ mutate: savePermissions }),
}));

const CLI: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: '',
  autoCompact: false, autoCompactAt: 80, advisorStyle: 'professional', discordUserId: '', whatsappNumber: '',
  autoRecall: true, autoSave: true,
};
const PERMISSIONS: PermissionSettings = { tools: {}, bash: {}, yolo: false };
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMyCliSettings: () => ({ data: CLI, isLoading: false }),
  useMyPermissions: () => ({ data: PERMISSIONS, isLoading: false }),
  useBrainModels: () => ({ data: [] }),
}));

import { CliSection } from '../../../modules/account/CliSection';

const renderSection = () => render(<ToastProvider><CliSection /></ToastProvider>, { wrapper: createWrapper().wrapper });

beforeEach(() => { saveCli.mockClear(); savePermissions.mockClear(); });

describe('CliSection — YOLO default toggle', () => {
  it('renders the YOLO card with its warning description, seeded off', () => {
    renderSection();
    expect(screen.getByText(en.cli.yoloTitle)).toBeTruthy();
    expect(screen.getByText(en.cli.yoloWarning)).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: en.cli.yoloToggle });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('flipping the toggle autosaves ONLY the permissions blob ({ yolo: true })', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('switch', { name: en.cli.yoloToggle }));
    await waitFor(() => expect(savePermissions).toHaveBeenCalled(), { timeout: 1500 });
    expect(savePermissions.mock.calls[0]![0]).toEqual({ yolo: true });
    // The YOLO flip never rides the cli-settings PATCH (that one restarts the brain).
    expect(saveCli).not.toHaveBeenCalled();
  });
});
