import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { color } from './theme.js';
import { spinnerFrame } from './components.js';
import { formatDuration, formatK, terminalInlineText } from '../ui/text.js';
import { WORK_MODE_LABEL, type BrainWorkMode, type GoalView } from './brainClient.js';
import { goalElapsedSeconds } from './goalState.js';
import type { Keymap, KeybindAction } from './keys.js';

/** Pure line-composition helpers for the chat shell: the statusline, the composer meta line, the adaptive
 *  footer/start-screen hints and the width fitters that fit them. No TUI or ChatState dependency — every
 *  function is a pure string/size transform, so the module is unit-testable without a terminal. */

/** Render the bottom statusline from the plugin's display toggles + live usage. Empty string when the
 *  statusline plugin is disabled or nothing is toggled on. Pure — unit-testable without a TTY. */
export function statusline(
  cfg: { showModel?: boolean; showContext?: boolean; showTokens?: boolean; showCost?: boolean } | null,
  usage: { tokens: number | null; contextWindow: number; percent: number | null; totalTokens: number; cost: number } | null,
  model: string,
): string {
  if (!cfg) return '';
  const parts: string[] = [];
  if (cfg.showModel && model) parts.push(model);
  if (cfg.showContext && usage && usage.percent != null) {
    parts.push(`context ${Math.round(usage.percent)}% (${formatK(usage.tokens ?? 0)}/${formatK(usage.contextWindow)})`);
  }
  if (cfg.showTokens && usage) parts.push(`Σ ${formatK(usage.totalTokens)} tok`);
  if (cfg.showCost && usage) parts.push(`$${usage.cost.toFixed(2)}`);
  return parts.join('  ·  ');
}

/** Claude-Code-shaped settled turn metadata: one quiet icon + compact duration, composed here rather
 * than in the renderer so live and settled labels share the chat shell's existing metadata language. */
export function settledTurnMeta(durationMs: number): string {
  return `${color.faint('✻')} ${color.faint(`Worked for ${formatDuration(durationMs / 1000)}`)}`;
}

/** One stable composer activity chip. Compaction is named explicitly because the agent run may already
 * be idle while its summary request is still busy; ordinary generation keeps the compact spinner/time. */
export function activityChip(activity: 'agent' | 'compaction' | null, seconds: number): string | undefined {
  if (!activity) return undefined;
  const label = activity === 'compaction' ? `${color.warning('compacting')} ` : '';
  return `${color.accent(spinnerFrame())} ${label}${color.faint(formatDuration(seconds))}`;
}

/** Active-goal status lives in the existing composer metadata row, so it consumes no layout height and
 * remains stable on small terminals. StatusBar owns final width truncation; the title is bounded first so
 * model/mode and the goal's progress/time remain the high-priority prefix. */
export function goalMeta(goal: GoalView | null, now = Date.now()): { primary: string; suffix: string } | null {
  if (goal?.status !== 'active') return null;
  const title = truncateToWidth(terminalInlineText(goal.goal), 36, '…');
  const budget = goal.turn_budget > 0 ? `${goal.turns_used}/${goal.turn_budget}` : `${goal.turns_used}`;
  return {
    primary: `${color.accent('◆ Goal')} ${color.faint(`${budget} · ${formatDuration(goalElapsedSeconds(goal, now))}`)}`,
    suffix: title ? `${color.faint('·')} ${color.dim(title)}` : '',
  };
}

/** One keyboard-hint segment in an adaptive footer line. `priority` sets the drop order when the
 *  line must shrink: lowest disappears first (ties break rightmost); the state's primary action
 *  carries the highest priority and always survives. */
export interface HintSegment {
  text: string;
  priority: number;
}

/** Join segments with `separator`, dropping whole lowest-priority segments until the line fits
 *  `width`. A segment's text is never shortened: at least one survives even when wider than the
 *  budget, leaving the caller's truncation as the defensive path for that case only. Pure. */
export function fitSegments(segments: readonly HintSegment[], width: number, separator = '   ·   '): string {
  const kept = segments.filter((s) => visibleWidth(s.text) > 0);
  const sepWidth = visibleWidth(separator);
  const total = (): number =>
    kept.reduce((sum, s) => sum + visibleWidth(s.text), 0) + Math.max(0, kept.length - 1) * sepWidth;
  while (kept.length > 1 && total() > width) {
    let drop = 0;
    for (let i = 1; i < kept.length; i++) {
      // The loop guard keeps both indices in range; `?? 0` only satisfies the compiler.
      if ((kept[i]?.priority ?? 0) <= (kept[drop]?.priority ?? 0)) drop = i;
    }
    kept.splice(drop, 1);
  }
  return kept.map((s) => s.text).join(separator);
}

/** First candidate whose visible width fits `width`, else the last (most reduced) one. Pure. */
export function fitVariants(candidates: readonly string[], width: number): string {
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= width) return candidate;
  }
  return candidates[candidates.length - 1] ?? '';
}

/** The bottom-bar hint segments for the given chat state, rendered from the ACTIVE keymap — hints must
 *  stay truthful when the user rebinds a shortcut. Unbound actions drop their segment. Pure. */
export function bottomHintItems(
  keymap: Keymap,
  state: 'child' | 'thinking' | 'idle',
  hasSubagents = false,
  interruptArmed = false,
  hasQueued = false,
  hasForegroundSubagent = false,
  hasForegroundCommand = false,
  stopRequested = false,
): HintSegment[] {
  const k = (action: KeybindAction, label: string): string => {
    const chord = keymap.chordLabel(action);
    return chord ? `${chord} ${label}` : '';
  };
  const seg = (text: string, priority: number): HintSegment[] => (text ? [{ text, priority }] : []);
  // One chord backgrounds whatever is in the foreground; name it for whichever is actually waiting (a
  // delegate takes precedence in the label when both are, but the chord detaches both).
  const backgroundHint = hasForegroundSubagent
    ? k('subagent_background', 'background sub-agent')
    : hasForegroundCommand ? k('subagent_background', 'background command') : '';
  if (state === 'child') {
    return [
      ...seg('⏎ message the sub-agent', 100),
      ...seg('esc back', 90),
      ...seg(k('subagent_cycle', 'next session'), 20),
    ];
  }
  if (state === 'thinking') {
    return [
      // After the abort was issued, a turn still shown as thinking is pinned by its running command —
      // advertise the escalation instead of the interrupt the loop already received.
      ...seg(hasQueued ? 'esc inject queued'
        : stopRequested && hasForegroundCommand ? 'esc kill command'
          : interruptArmed ? 'esc again to interrupt' : 'esc interrupt', 100),
      ...seg(backgroundHint, 40),
      ...seg('/help commands', 50),
      ...seg(k('reasoning_cycle', 'reasoning'), 20),
      ...seg(hasSubagents ? k('subagent_cycle', 'subagents') : '', 30),
    ];
  }
  return [
    ...seg('⏎ send', 100),
    ...seg('/ slash', 80),
    ...seg('@ files', 70),
    ...seg('! shell', 60),
    ...seg(k('stash', 'stash'), 40),
    ...seg(k('mode_toggle', 'mode'), 50),
    ...seg(k('reasoning_cycle', 'reasoning'), 30),
    ...seg(k('telemetry_toggle', 'telemetry'), 20),
  ];
}

/** The start-screen hint segments — same keymap-driven contract as {@link bottomHintItems}. Pure. */
export function startScreenHintItems(keymap: Keymap): HintSegment[] {
  const mode = keymap.chordLabel('mode_toggle');
  return [
    { text: '⏎ send', priority: 100 },
    { text: '/ commands', priority: 80 },
    { text: '@ files', priority: 70 },
    { text: '! shell', priority: 60 },
    { text: '↑ history', priority: 50 },
    ...(mode ? [{ text: `${mode} mode`, priority: 40 }] : []),
  ];
}

/** The bottom-bar right side ("ctrl+c quit"), empty when quit is unbound. Pure. */
export function quitHint(keymap: Keymap): string {
  const chord = keymap.chordLabel('quit');
  return chord ? `${chord} quit` : '';
}

/** The composer's meta line. `generating` (the spinner + elapsed chip) sits directly after the mode label
 *  rather than at the far end: it is the one part that appears and disappears mid-turn, and next to the
 *  fixed-width mode label it stays where the eye already is instead of shifting with the model name's
 *  length. Pure — unit-testable without a TTY. */
export function modelMetaLine(
  mode: BrainWorkMode,
  modelName: string,
  thinkingLevel: string,
  generating?: string,
  yolo?: boolean,
  fast?: boolean,
  activeGoal?: { primary: string; suffix: string } | null,
): string {
  const raw = modelName || '—';
  const slash = raw.indexOf('/');
  const provider = slash > 0 ? raw.slice(0, slash) : '';
  const model = slash > 0 ? raw.slice(slash + 1) : raw;
  return [
    `  ${color.accent(WORK_MODE_LABEL[mode])}`,
    generating ?? '',
    color.faint('·'),
    activeGoal?.primary ?? '',
    activeGoal ? color.faint('·') : '',
    // Provider first, then the model it qualifies, separated by the same faint dot the rest of the line
    // uses. Reading order matches how the identity is written and typed (`anthropic/claude-opus-5`), and
    // the dot keeps the two from looking like one long name.
    provider ? color.dim(provider) : '',
    provider ? color.faint('·') : '',
    color.text(model),
    thinkingLevel ? color.warning(thinkingLevel) : '',
    fast ? color.accent('FAST') : '',
    // Warning-toned so auto-approved tool asks are never invisible (session /yolo or the persisted default).
    yolo ? color.warning('YOLO') : '',
    activeGoal?.suffix ?? '',
  ].filter(Boolean).join(' ');
}
