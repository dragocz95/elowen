import { describe, it, expect } from 'vitest';
import { ensurePluginUiRuntime } from '../../../../web/lib/pluginUi';

// The views resolve every component, hook and helper through window.ElowenUiRuntime at module
// scope — install the REAL runtime first (the same records the app hands a bundle), then import
// them, exactly as the host page does in the browser.
ensurePluginUiRuntime();
const { buildTaskMenu, SPEC_DIVIDER } = await import('./taskContextMenu');
import type { TaskMenuCtx, TaskMenuActionId, TaskMenuSubmenuId, TaskMenuEntry, TaskMenuOption } from './taskContextMenu';
import type { Task } from '../types';

const task = (over: Partial<Task> & { id: string }): Task => ({ title: over.id, status: 'open', ...over });

const ctx = (over: Partial<TaskMenuCtx> & { task: Task; kind: TaskMenuCtx['kind'] }): TaskMenuCtx => ({
  running: false, hasSession: false, hasBlockers: false, isGated: false, canMutate: true,
  models: [{ label: 'Sonnet', exec: 'sonnet' }, { label: 'Opus', exec: 'opus' }], currentExec: '',
  ...over,
});

/** Ids of leaf actions present in the spec. */
const ids = (entries: TaskMenuEntry[]): TaskMenuActionId[] =>
  entries.filter((e): e is Extract<TaskMenuEntry, { kind: 'item' }> => e !== SPEC_DIVIDER && e.kind === 'item').map((e) => e.id);
/** A leaf action's enabled flag, or undefined when the action is absent. */
const enabled = (entries: TaskMenuEntry[], id: TaskMenuActionId): boolean | undefined =>
  entries.find((e): e is Extract<TaskMenuEntry, { kind: 'item' }> => e !== SPEC_DIVIDER && e.kind === 'item' && e.id === id)?.enabled;
const submenu = (entries: TaskMenuEntry[], id: TaskMenuSubmenuId): Extract<TaskMenuEntry, { kind: 'submenu' }> | undefined =>
  entries.find((e): e is Extract<TaskMenuEntry, { kind: 'submenu' }> => e !== SPEC_DIVIDER && e.kind === 'submenu' && e.id === id);

describe('buildTaskMenu', () => {
  it('a running standalone task offers stop/pause/terminal but not start', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 't1', status: 'in_progress' }), kind: 'standalone', running: true, hasSession: true }));
    expect(ids(m)).toContain('stop');
    expect(ids(m)).toContain('pause');
    expect(ids(m)).toContain('terminal');
    expect(ids(m)).not.toContain('start');
  });

  it('an idle standalone task with no blockers can start; with blockers start is disabled', () => {
    const idle = buildTaskMenu(ctx({ task: task({ id: 't1' }), kind: 'standalone' }));
    expect(enabled(idle, 'start')).toBe(true);
    const blocked = buildTaskMenu(ctx({ task: task({ id: 't1' }), kind: 'standalone', hasBlockers: true }));
    expect(enabled(blocked, 'start')).toBe(false);
  });

  it('a closed task offers reopen and copy/delete but no start or close', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 't1', status: 'closed' }), kind: 'standalone' }));
    expect(ids(m)).toContain('reopen');
    expect(ids(m)).not.toContain('start');
    expect(ids(m)).not.toContain('close');
    expect(ids(m)).toContain('delete');
  });

  it('a gated phase offers approveGate; an ungated one does not', () => {
    const gated = buildTaskMenu(ctx({ task: task({ id: 'p1', status: 'blocked', parent_id: 'e1' }), kind: 'phase', isGated: true }));
    expect(ids(gated)).toContain('approveGate');
    const plain = buildTaskMenu(ctx({ task: task({ id: 'p1', parent_id: 'e1' }), kind: 'phase' }));
    expect(ids(plain)).not.toContain('approveGate');
  });

  it('an epic offers runReview, addPhase and deleteMission but no run controls or planMission', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 'e1', type: 'epic' }), kind: 'epic' }));
    expect(ids(m)).toEqual(expect.arrayContaining(['runReview', 'addPhase', 'deleteMission', 'copyId']));
    expect(ids(m)).not.toContain('start');
    expect(ids(m)).not.toContain('planMission');
    expect(ids(m)).not.toContain('delete');
  });

  it('planMission is offered only on a standalone task, not a phase or epic', () => {
    expect(ids(buildTaskMenu(ctx({ task: task({ id: 't1' }), kind: 'standalone' })))).toContain('planMission');
    expect(ids(buildTaskMenu(ctx({ task: task({ id: 'p1', parent_id: 'e1' }), kind: 'phase' })))).not.toContain('planMission');
    expect(ids(buildTaskMenu(ctx({ task: task({ id: 'e1', type: 'epic' }), kind: 'epic' })))).not.toContain('planMission');
  });

  it('the model submenu lists every model plus a default option, marking the current one', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 't1' }), kind: 'standalone', currentExec: 'opus' }));
    const sm = submenu(m, 'setModel');
    expect(sm?.options.map((o: TaskMenuOption) => o.value)).toEqual(['', 'sonnet', 'opus']);
    expect(sm?.options.find((o: TaskMenuOption) => o.value === 'opus')?.current).toBe(true);
    expect(sm?.options.find((o: TaskMenuOption) => o.value === '')?.current).toBe(false);
  });

  it('the model submenu is disabled while the agent is running', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 't1', status: 'in_progress' }), kind: 'standalone', running: true, hasSession: true }));
    expect(submenu(m, 'setModel')?.enabled).toBe(false);
  });

  it('the status submenu omits in_progress and marks the current status', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 't1', status: 'blocked' }), kind: 'standalone' }));
    const sm = submenu(m, 'setStatus');
    expect(sm?.options.map((o: TaskMenuOption) => o.value)).toEqual(['open', 'blocked', 'closed', 'cancelled']);
    expect(sm?.options.find((o: TaskMenuOption) => o.value === 'blocked')?.current).toBe(true);
  });

  it('without mutate rights, mutating actions disable but open/copy/terminal stay enabled', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 't1', status: 'in_progress' }), kind: 'standalone', running: true, hasSession: true, canMutate: false }));
    expect(enabled(m, 'open')).toBe(true);
    expect(enabled(m, 'copyId')).toBe(true);
    expect(enabled(m, 'terminal')).toBe(true);
    expect(enabled(m, 'stop')).toBe(false);
    expect(enabled(m, 'edit')).toBe(false);
    expect(submenu(m, 'setPriority')?.enabled).toBe(false);
  });

  it('never starts or ends with a divider and has no consecutive dividers', () => {
    const m = buildTaskMenu(ctx({ task: task({ id: 't1' }), kind: 'standalone' }));
    expect(m[0]).not.toBe(SPEC_DIVIDER);
    expect(m[m.length - 1]).not.toBe(SPEC_DIVIDER);
    for (let i = 1; i < m.length; i++) expect(m[i] === SPEC_DIVIDER && m[i - 1] === SPEC_DIVIDER).toBe(false);
  });
});
