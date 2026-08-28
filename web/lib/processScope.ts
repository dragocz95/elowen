import type { ProcessInfo } from './types';
import type { SubagentState } from './transcript';

/** Terminal process cards used to have one global id and are now scoped by account. Both shapes remain
 * durable in old session snapshots, so every process-specific surface recognizes the whole namespace. */
export function isBackgroundProcessCardId(id: string): boolean {
  return id === 'bg-processes' || id.startsWith('bg-processes-');
}

/** Which background processes belong to the open conversation — the ONE rule both live views share (the
 *  transcript panel showing them, the telemetry rail splitting its own from the rest), so the two can no
 *  longer disagree about what "this conversation" owns.
 *
 *  A delegated sub-agent runs under its own `brain-ch-subagent-*` session id, so matching the conversation
 *  id alone would hide a job the conversation itself set in motion. Its children count as its work. */
export function ownedSessionIds(activeSessionId: string | null, subagents: readonly SubagentState[]): ReadonlySet<string> {
  const ids = new Set<string>();
  if (activeSessionId !== null) ids.add(activeSessionId);
  for (const agent of subagents) ids.add(agent.sessionId);
  return ids;
}

/** A process with no session is owner-wide work with no conversation to attribute it to, so it is never
 *  "ours" — without this guard a null id would match a null active session and leak into every chat. */
export function isOwnProcess(proc: ProcessInfo, owned: ReadonlySet<string>): boolean {
  return proc.sessionId !== null && owned.has(proc.sessionId);
}

/** Where a process came from, for rows that are NOT the open conversation's: a delegated sub-agent, a
 *  channel session (Discord/WhatsApp…), or one of the user's other chats. Returns the i18n key under
 *  `t.processes`, or null for a session-less process — there is no origin to name, so it gets no badge. */
export function processOrigin(sessionId: string | null): 'subagent' | 'channel' | 'otherChat' | null {
  if (sessionId === null) return null;
  if (sessionId.startsWith('brain-ch-subagent-')) return 'subagent';
  if (sessionId.startsWith('brain-ch-')) return 'channel';
  return 'otherChat';
}
