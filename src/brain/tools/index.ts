import type { OrcaToolCtx } from './orcaTools.js';
import { orcaListTasks, orcaCreateTask, orcaPlan, orcaListMissions, orcaListSessions } from './orcaTools.js';

export type { OrcaToolCtx } from './orcaTools.js';

/** The brain's Orca capability toolset. Every tool wraps callOrcaApi (single source of truth), so a
 *  new REST endpoint needs no changes here beyond adding one more thin wrapper. */
export function buildOrcaTools(ctx: OrcaToolCtx) {
  return [orcaListTasks(ctx), orcaCreateTask(ctx), orcaPlan(ctx), orcaListMissions(ctx), orcaListSessions(ctx)];
}
