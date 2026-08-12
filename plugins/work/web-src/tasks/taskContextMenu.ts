import type { Task } from '../types';


/** Which structural kind a right-clicked task is — drives which actions apply. */
type TaskMenuKind = 'standalone' | 'phase' | 'epic';

/** Every action a task context menu can offer. The hook maps each id to a label, icon and handler;
 *  the builder stays pure (no JSX/i18n) so it's unit-testable on the (id, enabled) contract alone. */
export type TaskMenuActionId =
  | 'open' | 'edit'
  | 'start' | 'stop' | 'pause' | 'terminal'
  | 'dependencies'
  | 'reopen' | 'approveGate'
  | 'runReview' | 'addPhase' | 'planMission'
  | 'close' | 'copyId'
  | 'delete' | 'deleteMission';

/** A submenu whose options are data-driven (models / priorities / statuses). */
export type TaskMenuSubmenuId = 'setModel' | 'setPriority' | 'setStatus';

export interface TaskMenuOption { value: string; current: boolean }
interface TaskMenuItemSpec { kind: 'item'; id: TaskMenuActionId; enabled: boolean }
interface TaskMenuSubmenuSpec { kind: 'submenu'; id: TaskMenuSubmenuId; enabled: boolean; options: TaskMenuOption[] }
export const SPEC_DIVIDER = 'divider' as const;
export type TaskMenuEntry = TaskMenuItemSpec | TaskMenuSubmenuSpec | typeof SPEC_DIVIDER;

/** Everything the builder needs about a task's live/structural state, resolved by the hook from the
 *  query caches. Keeping it a plain record (no hooks) is what makes `buildTaskMenu` testable. */
export interface TaskMenuCtx {
  task: Task;
  kind: TaskMenuKind;
  running: boolean;
  hasSession: boolean;
  hasBlockers: boolean;
  /** The task carries a `gatedby:<phaseId>` label — a review gate is holding it. */
  isGated: boolean;
  /** Whether the current user may mutate this task (false → mutating actions render disabled). */
  canMutate: boolean;
  /** Selectable models (exec specs); '' is the "use default" option. */
  models: { label: string; exec: string }[];
  /** The task's current exec spec ('' when it inherits the configured default). */
  currentExec: string;
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
/** Statuses a human can set by hand. `in_progress` is intentionally excluded — that transition is
 *  owned by spawning an agent, not a manual pick. */
const MANUAL_STATUSES = ['open', 'blocked', 'closed', 'cancelled'];

/** Drop leading/trailing dividers and collapse runs of consecutive ones, so no group separator ever
 *  renders against an empty section. */
function compact(entries: TaskMenuEntry[]): TaskMenuEntry[] {
  const out: TaskMenuEntry[] = [];
  for (const e of entries) {
    if (e === SPEC_DIVIDER) {
      if (out.length === 0 || out[out.length - 1] === SPEC_DIVIDER) continue;
    }
    out.push(e);
  }
  while (out.length && out[out.length - 1] === SPEC_DIVIDER) out.pop();
  return out;
}

/** Build the declarative menu spec for a right-clicked task. Pure: same ctx → same entries. */
export function buildTaskMenu(ctx: TaskMenuCtx): TaskMenuEntry[] {
  const { task, kind, running, hasSession, hasBlockers, isGated, canMutate, models, currentExec } = ctx;
  const closed = task.status === 'closed' || task.status === 'cancelled';
  const mut = canMutate; // shorthand: mutating actions require it
  const entries: TaskMenuEntry[] = [];
  const item = (id: TaskMenuActionId, enabled: boolean) => entries.push({ kind: 'item', id, enabled });

  // 1) Navigation
  item('open', true);
  item('edit', mut);

  if (kind === 'epic') {
    // 2) Mission-level work
    entries.push(SPEC_DIVIDER);
    item('runReview', mut);
    item('addPhase', mut);
    entries.push(SPEC_DIVIDER);
    item('copyId', true);
    item('deleteMission', mut);
    return compact(entries);
  }

  // 2) Run controls (standalone + phase). Start only shows when idle and open — a running task shows
  // Stop instead, a closed one shows Reopen below; so Start is never a dead/disabled row.
  entries.push(SPEC_DIVIDER);
  if (!running && !closed) item('start', mut && !hasBlockers);
  if (running) item('stop', mut);
  if (running && hasSession) item('pause', mut);
  if (hasSession) item('terminal', true);

  // 3) Metadata submenus + dependencies
  entries.push(SPEC_DIVIDER);
  entries.push({
    kind: 'submenu', id: 'setModel', enabled: mut && !running,
    options: [{ value: '', current: currentExec === '' }, ...models.map((m) => ({ value: m.exec, current: m.exec === currentExec }))],
  });
  entries.push({
    kind: 'submenu', id: 'setPriority', enabled: mut,
    options: PRIORITIES.map((p) => ({ value: p, current: (task.priority ?? 'P2') === p })),
  });
  entries.push({
    kind: 'submenu', id: 'setStatus', enabled: mut,
    options: MANUAL_STATUSES.map((s) => ({ value: s, current: task.status === s })),
  });
  item('dependencies', mut);

  // 4) Lifecycle convenience
  entries.push(SPEC_DIVIDER);
  if (closed) item('reopen', mut);
  if (kind === 'phase' && isGated) item('approveGate', mut);
  if (kind === 'standalone') item('planMission', mut);
  if (!closed) item('close', mut);

  // 5) Clipboard + destructive
  entries.push(SPEC_DIVIDER);
  item('copyId', true);
  item('delete', mut);

  return compact(entries);
}
