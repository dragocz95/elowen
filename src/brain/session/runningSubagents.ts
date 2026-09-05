import type { BrainStore } from '../../store/brainStore.js';
import { xmlEscape } from '../../shared/xml.js';
import type { LiveBrain } from './liveBrain.js';
import type { LiveSessionRegistry } from './liveRegistry.js';

/** Remind the model that jobs it delegated are still running, so it neither duplicates nor waits on them.
 *
 *  Shared by every surface that runs a turn. It used to be composed by the owner chat's builder alone, so
 *  an agent that delegated from a platform room was never told on the next turn that its own children
 *  were still working — the one surface where the reminder matters most, because a room's turns are
 *  minutes apart and the transcript in between belongs to other people. */
export function runningSubagentsBlock(
  sessions: Pick<LiveSessionRegistry<LiveBrain>, 'childrenOf'>,
  store: Pick<BrainStore, 'getSubagentRuns' | 'activeDelegationChildIds'>,
  sessionId: string,
): string {
  // The same liveness the transcript read model and DelegateList use (see BrainStatusService.subagentRuns):
  // a run row whose lifecycle is still open, plus whatever the registry already claims. The model must not
  // be told a child is finished that its own DelegateList would report running — a boot-claimed child whose
  // recovery turn has not registered yet was exactly such a gap.
  const active = new Set([...sessions.childrenOf(sessionId), ...store.activeDelegationChildIds(sessionId)]);
  const running = store.getSubagentRuns(sessionId)
    .filter((run) => run.status === 'running' && active.has(run.sessionId));
  if (running.length === 0) return '';
  const rows = running.slice(0, 32).map((run) => {
    const attrs = `session="${xmlEscape(run.sessionId)}" background="${run.background === true}" auto-deliver="${run.autoDeliver === true}" tools="${run.tools}" seconds="${run.seconds}"`;
    // The child's current tool (`run.detail`) is a UI-only projection (web AgentsTable + CLI live
    // progress); it is deliberately withheld from the model here (context hardening) so the parent
    // cannot steer on the child's internal tool trace.
    return `<subagent ${attrs}>\n<task>${xmlEscape(run.task)}</task>\n</subagent>`;
  }).join('\n');
  const automatic = running.some((run) => run.autoDeliver === true);
  const manual = running.some((run) => run.background === true && run.autoDeliver !== true);
  const delivery = [
    // The whole point: an auto-delivered result arrives as a fresh turn, and it CANNOT be delivered while
    // this turn is still streaming. Waiting or polling here delays the very result the model waits for.
    automatic ? 'Jobs marked auto-deliver hand you their result on their own, in a new turn — you never fetch it, '
      + 'and it can only arrive once this turn is over. So do the work you can do now and then end your turn; if '
      + 'there is nothing else to do, say so briefly and end it. Do not wait for them and do not poll DelegateStatus.' : '',
    manual ? 'Jobs without auto-deliver are collected with DelegateResult on a later turn; do not busy-wait for them.' : '',
  ].filter(Boolean).join(' ');
  return '<system-reminder>\n<running-subagents>\n'
    + `${rows}\n</running-subagents>\n`
    + `<instruction>These delegated jobs are already running. Do not duplicate or abort them. ${delivery}</instruction>\n`
    + '</system-reminder>';
}
