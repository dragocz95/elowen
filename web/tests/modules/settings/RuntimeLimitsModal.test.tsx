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
    const floor = screen.getByRole('slider', { name: 'Memory relevance floor' });
    expect(floor).toHaveAttribute('aria-valuemin', '0.1');
    expect(floor).toHaveAttribute('aria-valuemax', '0.8');

    fireEvent.keyDown(floor, { key: 'ArrowRight' });
    expect(apply(0).limits.memorySemanticFloorPerMille).toBe(210);
  });

  it('shows a duration in seconds and a retention in days, and writes canonical units back', () => {
    const { apply } = renderModal();

    expect(screen.getByText('30 s')).toBeTruthy();
    // Two retention knobs share the days unit (activity log, IP address), so the value alone is ambiguous.
    expect(screen.getAllByText('30 days')).toHaveLength(2);

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Local shell timeout' }), { key: 'ArrowRight' });
    expect(apply(0).limits.localShellTimeoutMs).toBe(35000);

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Activity log retention' }), { key: 'ArrowLeft' });
    expect(apply(1).limits.eventRetentionDays).toBe(29);

    fireEvent.keyDown(screen.getByRole('slider', { name: 'IP address retention' }), { key: 'ArrowRight' });
    expect(apply(2).limits.originIpRetentionDays).toBe(31);
  });

  it('keeps a slider change inside the canonical field bounds', () => {
    const { apply } = renderModal();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Local shell timeout' }), { key: 'End' });
    expect(apply(0).limits.localShellTimeoutMs).toBe(300000); // the slider and daemon share this ceiling
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
