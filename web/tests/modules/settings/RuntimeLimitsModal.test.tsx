import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { RuntimeLimitsModal, RUNTIME_LIMIT_DEFAULTS } from '../../../modules/settings/RuntimeLimitsModal';
import type { RuntimeConfig } from '../../../lib/types';

const CONFIG: RuntimeConfig = { limits: RUNTIME_LIMIT_DEFAULTS, toolDeferralEnabled: true, subagentRunnerEnabled: false, subagentRunnerPoolMax: null };

/** Collects what the editor writes back — the caller holds the draft, so an update is a function. */
function renderModal(runtime: RuntimeConfig = CONFIG, props: Partial<Parameters<typeof RuntimeLimitsModal>[0]> = {}) {
  const updates: ((cur: RuntimeConfig) => RuntimeConfig)[] = [];
  const result = render(
    <LanguageProvider>
      <RuntimeLimitsModal runtime={runtime} onChange={(update) => updates.push(update)} onClose={() => {}} {...props} />
    </LanguageProvider>,
  );
  const apply = (index: number): RuntimeConfig => {
    const update = updates[index];
    if (!update) throw new Error(`no update at index ${index}`);
    return update(runtime);
  };
  return { updates, apply, unmount: result.unmount };
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
    // Two retention knobs share the 30-day value (activity log, IP address); provider diagnostics use
    // their own shorter window and a separate storage budget.
    expect(screen.getAllByText('30 days')).toHaveLength(2);
    expect(screen.getByText('14 days')).toBeTruthy();
    expect(screen.getByText('1024 MiB')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Local shell timeout' }), { key: 'ArrowRight' });
    expect(apply(0).limits.localShellTimeoutMs).toBe(35000);

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Activity log retention' }), { key: 'ArrowLeft' });
    expect(apply(1).limits.eventRetentionDays).toBe(29);

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Provider diagnostics retention' }), { key: 'ArrowLeft' });
    expect(apply(2).limits.providerRequestRetentionDays).toBe(13);

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Provider diagnostics storage limit' }), { key: 'ArrowRight' });
    expect(apply(3).limits.providerRequestRetentionMiB).toBe(1088);

    fireEvent.keyDown(screen.getByRole('slider', { name: 'IP address retention' }), { key: 'ArrowRight' });
    expect(apply(4).limits.originIpRetentionDays).toBe(31);
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

  it('offers the mid-turn reminder row only when a plugin contributes a provider', () => {
    const label = 'Mid-turn reminder interval';
    // No provider loaded means no row — a cadence nobody listens to is a dead control — and the same hold
    // covers the gate still loading (`undefined`), which must not flash a knob it cannot honour.
    const { unmount } = renderModal();
    expect(screen.queryByRole('slider', { name: label })).toBeNull();

    unmount();
    const withProviders = renderModal(CONFIG, { stepContextAvailable: true });
    const sliders = screen.getAllByRole('slider');
    const slider = screen.getByRole('slider', { name: label });
    // Appended LAST, so every positional `apply(n)` above keeps pointing at the field it was written for.
    expect(sliders[sliders.length - 1]).toBe(slider);
    expect(sliders).toHaveLength(15);
    // Slider bounds mirror the daemon clamp, so the row can never offer a value the daemon would lower.
    expect(slider).toHaveAttribute('aria-valuemin', '10');
    expect(slider).toHaveAttribute('aria-valuemax', '100');
    expect(slider).toHaveAttribute('aria-valuetext', String(RUNTIME_LIMIT_DEFAULTS.stepContextEveryToolCalls));
    fireEvent.keyDown(slider, { key: 'End' });
    expect(withProviders.apply(0).limits.stepContextEveryToolCalls).toBe(100);
  });
});
