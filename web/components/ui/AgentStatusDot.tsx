import { liveState, type LiveState } from '../../lib/agentUtils';
import type { DerivedSignal } from '../../lib/types';
import { useTranslation } from '../../lib/i18n';

const STYLE: Record<LiveState, { color: string; ring: string; pulse: boolean }> = {
  working: { color: 'var(--color-success)', ring: 'color-mix(in srgb, var(--color-success) 50%, transparent)', pulse: true },
  needs_input: { color: 'var(--color-warning)', ring: 'color-mix(in srgb, var(--color-warning) 50%, transparent)', pulse: true },
  complete: { color: 'var(--color-text-muted)', ring: 'transparent', pulse: false },
  idle: { color: 'var(--color-border-strong)', ring: 'transparent', pulse: false },
};

/** A single live-state dot: green pulse (working), amber pulse (needs input), neutral (complete/idle). */
export function AgentStatusDot({ signal, live = false, size = 'md' }: { signal?: DerivedSignal; live?: boolean; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  const state = liveState(signal, live);
  const s = STYLE[state];
  const px = size === 'sm' ? 6 : 8;
  const label = t.agent[state === 'idle' ? 'idle' : state === 'needs_input' ? 'needsInput' : state];
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${s.pulse ? 'live-dot' : ''}`}
      style={{ width: px, height: px, backgroundColor: s.color, ['--live-ring' as string]: s.ring }}
      role="status"
      aria-label={label}
      title={label}
    />
  );
}
