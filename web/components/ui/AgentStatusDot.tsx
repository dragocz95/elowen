import { liveState, type LiveState } from '../../lib/agentUtils';
import type { DerivedSignal } from '../../lib/types';
import type { StallState } from '../../lib/useSessionStall';
import { useTranslation } from '../../lib/i18n';
import { useAgentsPlugin } from '../../lib/queries';

const STYLE: Record<LiveState, { color: string; ring: string; pulse: boolean }> = {
  working: { color: 'var(--color-success)', ring: 'color-mix(in srgb, var(--color-success) 50%, transparent)', pulse: true },
  needs_input: { color: 'var(--color-warning)', ring: 'color-mix(in srgb, var(--color-warning) 50%, transparent)', pulse: true },
  stalled: { color: 'var(--color-warning)', ring: 'color-mix(in srgb, var(--color-warning) 50%, transparent)', pulse: false },
  stuck: { color: 'var(--color-danger)', ring: 'color-mix(in srgb, var(--color-danger) 50%, transparent)', pulse: true },
  complete: { color: 'var(--color-text-muted)', ring: 'transparent', pulse: false },
  idle: { color: 'var(--color-border-strong)', ring: 'transparent', pulse: false },
};

/** Resolve the effective live state, giving priority to stall when the session
 *  is live but silent, then needs_input, then the SSE signal. */
function resolveState(signal: DerivedSignal | undefined, live: boolean, stall: StallState | undefined): LiveState {
  if (stall === 'stuck') return 'stuck';
  if (stall === 'stalled') return 'stalled';
  return liveState(signal, live);
}

/** A single live-state dot: green pulse (working), amber (stalled/needs input), red (stuck), neutral (complete/idle). */
export function AgentStatusDot({ signal, live = false, size = 'md', stall, silenceSec = 0 }: { signal?: DerivedSignal; live?: boolean; size?: 'sm' | 'md'; stall?: StallState; silenceSec?: number }) {
  const { t } = useTranslation();
  // Agent live-state comes entirely from the agents plugin's session surface; without the plugin the
  // dot could only ever render a meaningless neutral 'idle'. One gate here hides it product-wide
  // (task cards, kanban, phase log) instead of each caller re-checking.
  const agentsUi = useAgentsPlugin();
  if (!agentsUi) return null;
  const state = resolveState(signal, live, stall);
  const s = STYLE[state];
  const px = size === 'sm' ? 6 : 8;
  let label: string;
  if (state === 'stalled') label = t.agent.stalled.replace('{min}', String(Math.max(1, Math.floor(silenceSec / 60))));
  else if (state === 'stuck') label = t.agent.stuck.replace('{min}', String(Math.max(1, Math.floor(silenceSec / 60))));
  else label = t.agent[state === 'idle' ? 'idle' : state === 'needs_input' ? 'needsInput' : state];
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