import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { CategorizationSettings } from '../../../lib/types';

const updateConfig = vi.fn();
vi.mock('../../../lib/mutations', () => ({ useUpdateConfig: () => ({ mutate: updateConfig, mutateAsync: updateConfig }) }));

const CATEGORIZATION: CategorizationSettings = { providerId: 'anthropic', model: 'claude-haiku', baseUrl: '', configured: true };
const state = vi.hoisted(() => ({ digest: { providerId: '', model: '' } as { providerId: string; model: string } }));
vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useConfig: () => ({ data: {
    brain: { providers: [{ id: 'anthropic', label: 'Anthropic', type: 'oauth-anthropic' }] },
    dashboard: { recapEnabled: true, digestEnabled: true, greetingEnabled: false, pillsEnabled: false, continueEnabled: true, digestPerDay: 1, digest: state.digest },
  } }),
  useCategorizationSettings: () => ({ data: CATEGORIZATION }),
  useDashRecap: () => ({ data: { digest: { status: 'ready' } } }),
}));

import { DashboardSection } from '../../../modules/settings/DashboardSection';

const renderSection = (onOpenSection?: (id: string) => void) =>
  render(<ToastProvider><DashboardSection onOpenSection={onOpenSection} /></ToastProvider>, { wrapper: createWrapper().wrapper });

const digestRow = (container: HTMLElement) => Array.from(container.querySelectorAll('.settings-row'))
  .find((n) => n.querySelector('.settings-row__title')?.textContent?.startsWith(en.settings.dashboardSection.model))!;

beforeEach(() => {
  updateConfig.mockClear();
  state.digest = { providerId: '', model: '' };
});

/** Which model writes the digest is a ROLE now — Recap only states the answer. The rule it states is the
 *  daemon's own (`dashDigestInference`): the digest route counts only when BOTH halves are set. */
describe('Settings → Recap — the read-only digest model row', () => {
  it('names an explicit digest model, with no inherited badge', () => {
    state.digest = { providerId: 'anthropic', model: 'claude-opus' };
    const { container } = renderSection();
    const row = digestRow(container);
    expect(row.querySelector('.settings-row__status')!.textContent).toContain('claude-opus');
    expect(row.querySelector('.settings-row__status')!.textContent).not.toContain(en.settings.modelRoles.inherited);
  });

  it('names the utility model it inherits when no digest pair is stored', () => {
    const { container } = renderSection();
    const status = digestRow(container).querySelector('.settings-row__status')!;
    expect(status.textContent).toContain('claude-haiku');
    expect(status.textContent).toContain(en.settings.modelRoles.inherited);
  });

  /** THE REGRESSION. A half-set stored pair is not a route: the daemon falls through to the utility one.
   *  Reading `digest.model || categorization.model` reported the orphaned half as the digest model. */
  it.each([
    ['no provider', { providerId: '', model: 'orphaned-model' }],
    ['no model', { providerId: 'anthropic', model: '' }],
  ])('reads a half-set pair (%s) as inherited, exactly as the daemon does', (_label, digest) => {
    state.digest = digest;
    const { container } = renderSection();
    const status = digestRow(container).querySelector('.settings-row__status')!;
    expect(status.textContent).toContain('claude-haiku');
    expect(status.textContent).toContain(en.settings.modelRoles.inherited);
    expect(status.textContent).not.toContain('orphaned-model');
  });

  it('reports no model at all when neither route is complete', () => {
    state.digest = { providerId: 'anthropic', model: '' };
    CATEGORIZATION.model = ''; // the utility route is half-set too, so nothing resolves
    const { container } = renderSection();
    expect(digestRow(container).querySelector('.settings-row__status')!.textContent).toContain('—');
    CATEGORIZATION.model = 'claude-haiku';
  });

  it('sends the reader to the roles rather than editing the model here', () => {
    const onOpenSection = vi.fn();
    renderSection(onOpenSection);
    fireEvent.click(screen.getByRole('button', { name: en.settings.dashboardSection.modelLink }));
    expect(onOpenSection).toHaveBeenCalledWith('models');
    // No picker: the digest model is chosen beside the roles it inherits from.
    expect(digestRow(document.body).querySelector('[data-row-picker]')).toBeNull();
  });
});
