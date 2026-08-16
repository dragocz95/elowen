import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { RuntimeLimitsModal, RUNTIME_LIMIT_DEFAULTS } from '../../../modules/settings/RuntimeLimitsModal';
import type { RuntimeConfig } from '../../../lib/types';

const CONFIG: RuntimeConfig = { limits: RUNTIME_LIMIT_DEFAULTS, toolDeferralEnabled: true, remoteCompactionEnabled: false, subagentRunnerEnabled: false, subagentRunnerPoolMax: null };

/** Collects what the editor writes back — the caller holds the draft, so an update is a function. */
function renderModal(runtime: RuntimeConfig = CONFIG) {
  const updates: ((cur: RuntimeConfig) => RuntimeConfig)[] = [];
  render(
    <LanguageProvider>
      <RuntimeLimitsModal runtime={runtime} onChange={(update) => updates.push(update)} onClose={() => {}} />
    </LanguageProvider>,
  );
  const apply = (index: number): RuntimeConfig => {
    const update = updates[index];
    if (!update) throw new Error(`no update at index ${index}`);
    return update(runtime);
  };
  return { updates, apply };
}

describe('RuntimeLimitsModal', () => {
  it('shows the semantic floor as a cosine value but writes it back in per mille', () => {
    const { apply } = renderModal();

    // 200 per mille is the operator-facing 0.20 — displaying the raw 200 would be meaningless on a
    // similarity scale, and writing 0.2 back would be rounded to zero by the daemon's clamp.
    expect(screen.getByText('0.20')).toBeTruthy();
    const floor = screen.getByRole('slider', { name: 'Memory relevance floor' }) as HTMLInputElement;
    expect(floor.min).toBe('0.1');
    expect(floor.max).toBe('0.8');

    fireEvent.change(floor, { target: { value: '0.55' } });
    expect(apply(0).limits.memorySemanticFloorPerMille).toBe(550);
  });

  it('shows a duration in seconds and a retention in days, and writes canonical units back', () => {
    const { apply } = renderModal();

    expect(screen.getByText('30 s')).toBeTruthy();
    expect(screen.getByText('30 days')).toBeTruthy();

    fireEvent.change(screen.getByRole('slider', { name: 'Local shell timeout' }), { target: { value: '90' } });
    expect(apply(0).limits.localShellTimeoutMs).toBe(90000);

    fireEvent.change(screen.getByRole('slider', { name: 'Activity log retention' }), { target: { value: '7' } });
    expect(apply(1).limits.eventRetentionDays).toBe(7);
  });

  it('keeps a slider change inside the canonical field bounds', () => {
    const { apply } = renderModal();
    fireEvent.change(screen.getByRole('slider', { name: 'Local shell timeout' }), { target: { value: '9000' } });
    expect(apply(0).limits.localShellTimeoutMs).toBe(300000); // the daemon's ceiling, not the typed value
  });

  it('reports a clamped field with the value the daemon actually applied', () => {
    render(
      <LanguageProvider>
        <RuntimeLimitsModal runtime={CONFIG} applied={{ eventRetentionDays: 365 }} onChange={() => {}} onClose={() => {}} />
      </LanguageProvider>,
    );
    expect(screen.getByText(/Saved as 365 days/)).toBeTruthy();
  });

  it('turns the sub-agent runner on without disturbing the other runtime switches', () => {
    const { apply } = renderModal();
    fireEvent.click(screen.getByRole('switch', { name: 'Run sub-agents in separate processes' }));
    const next = apply(0);
    expect(next.subagentRunnerEnabled).toBe(true);
    expect(next.toolDeferralEnabled).toBe(true);
    expect(next.limits).toEqual(RUNTIME_LIMIT_DEFAULTS);
  });

  it('reflects the runner already being on, so the toggle cannot show a stale off state', () => {
    renderModal({ ...CONFIG, subagentRunnerEnabled: true });
    const toggle = screen.getByRole('switch', { name: 'Run sub-agents in separate processes' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});
