import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { CliSettings, PermissionSettings } from '../../../lib/types';

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
  it('keeps the YOLO warning behind the standard help affordance, seeded off', () => {
    renderSection();
    const title = screen.getByText(en.cli.yoloTitle);
    expect(screen.queryByText(en.cli.yoloWarning)).toBeNull();
    fireEvent.click(title.parentElement!.querySelector('button')!);
    expect(screen.getByRole('tooltip')).toHaveTextContent(en.cli.yoloWarning);
    const toggle = screen.getByRole('switch', { name: en.cli.yoloToggle });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('confirms the risky change, then autosaves ONLY the permissions blob ({ yolo: true })', async () => {
    renderSection();
    fireEvent.click(screen.getByRole('switch', { name: en.cli.yoloToggle }));
    expect(savePermissions).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: en.cli.yoloConfirmTitle })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.cli.yoloConfirm }));
    await waitFor(() => expect(savePermissions).toHaveBeenCalled(), { timeout: 1500 });
    expect(savePermissions.mock.calls[0]![0]).toEqual({ yolo: true });
    // The YOLO flip never rides the cli-settings PATCH (that one restarts the brain).
    expect(saveCli).not.toHaveBeenCalled();
  });
});

describe('CliSection — unattended asks (strict mode) segmented switch', () => {
  it('renders the card seeded on Allow (the server default)', () => {
    renderSection();
    expect(screen.getByText(en.cli.unattendedTitle)).toBeTruthy();
    const allow = screen.getAllByRole('radio', { name: en.cli.unattendedAllow })
      .find((r) => r.closest('[role="radiogroup"]')?.getAttribute('aria-label') === en.cli.unattendedTitle)!;
    expect(allow.getAttribute('aria-checked')).toBe('true');
  });

  it('picking Block autosaves ONLY { unattendedAsks: "deny" } on the permissions blob', async () => {
    renderSection();
    const block = screen.getAllByRole('radio', { name: en.cli.unattendedDeny })
      .find((r) => r.closest('[role="radiogroup"]')?.getAttribute('aria-label') === en.cli.unattendedTitle)!;
    fireEvent.click(block);
    await waitFor(() => expect(savePermissions).toHaveBeenCalled(), { timeout: 1500 });
    expect(savePermissions.mock.calls[0]![0]).toEqual({ unattendedAsks: 'deny' });
    expect(saveCli).not.toHaveBeenCalled();
  });
});
