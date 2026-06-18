'use client';
import type { Task } from '../../lib/types';
import { taskExec } from '../../lib/taskExec';
import { taskAgentName, taskSessionName, taskElapsed } from '../../lib/agentUtils';
import { useConfig } from '../../lib/queries';
import { ModelIcon } from './ModelIcon';

/** One-line agent identity: optional model icon, the `orca-<agent>` session name (or model
 *  fallback for unassigned tasks) and elapsed time since the task started. */
export function AgentIdentityStrip({ task, showTime = true, showIcon = false, iconSize = 14 }: { task: Task; showTime?: boolean; showIcon?: boolean; iconSize?: number }) {
  const { data: config } = useConfig();
  const exec = taskExec(task.labels) || config?.defaults?.exec || '';
  const identity = taskSessionName(task) ?? taskAgentName(task) ?? exec;
  const elapsed = showTime ? taskElapsed(task, Date.now()) : null;
  if (!identity && !elapsed) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-text-muted">
      {showIcon ? <ModelIcon name={exec} size={iconSize} /> : null}
      {identity ? <span className="truncate">{identity}</span> : null}
      {elapsed ? <><span aria-hidden className="opacity-50">·</span><span className="shrink-0">{elapsed}</span></> : null}
    </div>
  );
}
