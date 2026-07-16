import type { WorkflowUpdate } from './events.js';

/** Terminalize a workflow the daemon can no longer be running. The engine keeps its DAG in memory only,
 *  so a restart kills every node mid-flight while the durable row still says `running` — left alone, the
 *  transcript would show a spinner for work that died with the process.
 *
 *  `cancelled` at the top is what uniquely says "the daemon died under it": the engine itself only ever
 *  writes running/done/error. Non-terminal nodes become `error` — they were interrupted, and claiming
 *  otherwise would put fiction in the record of what ran.
 *
 *  Shared by the boot sweep (which persists the result) and statusService (which applies it as a display
 *  transform for the sessions boot never resumes) so both agree on what an orphan looks like. */
export function terminalizeWorkflow(run: WorkflowUpdate): WorkflowUpdate {
  return {
    ...run,
    status: 'cancelled',
    nodes: run.nodes.map((node) =>
      (node.status === 'done' || node.status === 'error' ? node : { ...node, status: 'error' as const })),
  };
}
