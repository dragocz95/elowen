import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { MemoryRetentionModal, DEFAULT_MEMORY_RETENTION } from '../../../modules/settings/MemoryRetentionModal';
import { RUNTIME_LIMIT_DEFAULTS } from '../../../modules/settings/RuntimeLimitsModal';
import type { RuntimeConfig } from '../../../lib/types';

const CONFIG: RuntimeConfig = {
  limits: RUNTIME_LIMIT_DEFAULTS,
  toolDeferralEnabled: true,
  remoteCompactionEnabled: false,
  subagentRunnerEnabled: false,
  subagentRunnerPoolMax: null,
  memoryRetention: {
    enabled: true,
    graceDays: 14,
    vitalityFloor: 10,
    halfLifeByImportance: { 1: 3, 2: 7, 3: 14, 4: 30, 5: 0 },
  },
};

/** Collects what the editor writes back — the caller holds the runtime draft, so an update is a function. */
function renderModal(runtime: RuntimeConfig = CONFIG) {
  const updates: ((cur: RuntimeConfig) => RuntimeConfig)[] = [];
  render(
    <LanguageProvider>
      <MemoryRetentionModal runtime={runtime} onChange={(update) => updates.push(update)} onClose={() => {}} />
    </LanguageProvider>,
  );
  const apply = (index: number): RuntimeConfig => {
    const update = updates[index];
    if (!update) throw new Error(`no update at index ${index}`);
    return update(runtime);
  };
  return { updates, apply };
}

describe('MemoryRetentionModal', () => {
  it('offers the master toggle, the grace window, the floor and one half-life slider per importance', () => {
    renderModal();
    expect(screen.getByRole('switch', { name: 'Memory retention enabled' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Grace period' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Vitality floor' })).toBeInTheDocument();
    for (const level of [1, 2, 3, 4]) {
      expect(screen.getByRole('slider', { name: `Half-life — importance ${level}` })).toBeInTheDocument();
    }
  });

  it('writes the toggle and every slider back into the runtime draft', () => {
    const { apply } = renderModal();

    fireEvent.click(screen.getByRole('switch', { name: 'Memory retention enabled' }));
    let next = apply(0);
    expect(next.memoryRetention?.enabled).toBe(false);

    fireEvent.change(screen.getByRole('slider', { name: 'Grace period' }), { target: { value: '30' } });
    next = apply(1);
    expect(next.memoryRetention?.graceDays).toBe(30);
    expect(next.memoryRetention?.vitalityFloor).toBe(10); // untouched fields stay

    fireEvent.change(screen.getByRole('slider', { name: 'Vitality floor' }), { target: { value: '40' } });
    next = apply(2);
    expect(next.memoryRetention?.vitalityFloor).toBe(40);

    fireEvent.change(screen.getByRole('slider', { name: 'Half-life — importance 2' }), { target: { value: '0.5' } });
    next = apply(3);
    expect(next.memoryRetention?.halfLifeByImportance[2]).toBe(0.5);
    expect(next.memoryRetention?.halfLifeByImportance[1]).toBe(3);
  });

  it('shows importance 5 as pinned instead of a half-life knob that would have no effect', () => {
    renderModal();
    // The daemon never decays or evicts importance-5 memories, so a slider there would be inert.
    expect(screen.queryByRole('slider', { name: 'Half-life — importance 5' })).toBeNull();
    expect(screen.getByText('Importance 5 — never removed')).toBeInTheDocument();
  });

  it('seeds from the daemon defaults so the editor never invents values', () => {
    expect(DEFAULT_MEMORY_RETENTION).toEqual(CONFIG.memoryRetention);
  });
});
