'use client';
import { Timer } from 'lucide-react';
import type { Task } from '../../lib/types';
import { taskExec } from '../../lib/agentUtils';
import { taskAgentName, taskSessionName, taskElapsed, agentDisplayName } from '../../lib/agentUtils';
import { useConfig } from '../../lib/queries';
import { ModelIcon } from './ModelIcon';

/** One-line agent identity: optional model icon, the friendly agent name (or model fallback for
 *  unassigned tasks) and the run duration — how long the agent ran (frozen once the task finishes),
 *  shown with a timer icon so it reads as a duration, not a clock time. */
export function AgentIdentityStrip({ task, showTime = true, showIcon = false, iconSize = 14 }: { task: Task; showTime?: boolean; showIcon?: boolean; iconSize?: number }) {
  const { data: config } = useConfig();
  const exec = taskExec(task.labels) || config?.defaults?.exec || '';
  const identity = taskSessionName(task) ?? taskAgentName(task) ?? exec;
  const ran = showTime ? taskElapsed(task, Date.now()) : null;
  if (!identity && !ran) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-text-muted">
      {showIcon ? <ModelIcon name={exec} size={iconSize} /> : null}
      {identity ? <span className="truncate">{agentDisplayName(identity)}</span> : null}
      {ran ? <><span aria-hidden className="opacity-50">·</span><span className="flex shrink-0 items-center gap-1"><Timer size={11} aria-hidden />{ran}</span></> : null}
    </div>
  );
}
