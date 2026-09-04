import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ELOWEN_VERSION } from '../api/version.js';
import type { BrainEvent, BrainUsage } from '../brain/events.js';
import type { BrainStreamSnapshot } from '../brain/session/liveEventReplay.js';
import type { DelegatedProgressEvent, DelegatedTurnRequest } from '../brain/delegatedTurn.js';
import { parseMcpBridgeSnapshot, type McpBridgeSnapshot } from '../plugins/mcpSnapshot.js';
import { parseHostRpcRequest, parseHostRpcResult, type HostRpcRequest, type HostRpcResult } from './hostRpc.js';

/** The forked runner's entry module. Resolved relative to THIS file so the daemon and the child always
 *  name the same build: in a packaged install both are `dist/subagent/*.js`. A source checkout run through
 *  `--experimental-strip-types` has no `.js` sibling — the runner is then simply unavailable and the
 *  dispatcher stays in-process (see SubagentRunnerHost). */
export const RUNNER_ENTRY = ((): string => {
  const js = fileURLToPath(new URL('./runner.js', import.meta.url));
  try {
    statSync(js);
    return js;
  } catch {
    return fileURLToPath(new URL('./runner.ts', import.meta.url));
  }
})();

/** What "the same build" means across the process boundary.
 *
 *  A runner is forked from whatever is on disk NOW, while the daemon is running whatever it loaded at
 *  boot. An in-place `npm run build` (or an `elowen update`) under a live daemon is exactly the skew that
 *  produces a child speaking a protocol — or composing a prompt — its parent does not have. The version
 *  alone cannot see that, since a rebuild of the same version is the common case, so the entry module's
 *  size+mtime rides along. The daemon captures this ONCE at startup; the runner recomputes it at boot and
 *  refuses a mismatch rather than serving turns from a different build. */
export function subagentBuildId(): string {
  try {
    const s = statSync(RUNNER_ENTRY);
    return `${ELOWEN_VERSION}:${s.size}:${Math.floor(s.mtimeMs)}`;
  } catch {
    return `${ELOWEN_VERSION}:missing`;
  }
}

/** Boot the runner: the database it attaches to (WITHOUT migrating — the daemon owns the schema) and the
 *  home project, so its brain core is constructed from the same inputs the daemon's was. */
interface RunnerBootMessage {
  type: 'boot';
  buildId: string;
  dbPath: string;
  project: { id: number; slug: string; path: string };
  /** The daemon's bridged MCP tool definitions AT THE INSTANT OF THIS FORK, so the runner can declare the
   *  same tools without connecting a single MCP server at boot (each one would otherwise launch its own
   *  server process tree — in production a whole Chrome per runner). Read fresh per fork rather than
   *  cached anywhere, so a runner mirrors the daemon's live registry by construction.
   *
   *  Extending the boot payload is safe precisely because {@link subagentBuildId} already refuses a
   *  cross-build pair: a runner that predates this field can never be handed one. ABSENT (not empty) when
   *  the daemon cannot say — the runner then connects at boot, exactly as it always did. */
  mcp?: McpBridgeSnapshot;
}

export type DaemonToRunner =
  | RunnerBootMessage
  /** Execute ONE delegated turn. `turnId` correlates the reply; `request` is re-validated on arrival. */
  | { type: 'turn'; turnId: string; request: DelegatedTurnRequest; text: string }
  /** Abort verb (the abort tree stays authoritative in the daemon — see LiveSessionRegistry). */
  | { type: 'abort'; channelId: string }
  /** Steer a parent's follow-up into a child turn RUNNING here (a DelegateContinue on a mid-turn child).
   *  The daemon has already authorized the caller against the child's ownership and scope; this process
   *  only carries the injection out and answers with the matching `steered` frame. */
  | { type: 'steer'; steerId: string; channelId: string; text: string }
  /** Install an atomic snapshot + live event tap on a session held in this runner. Unlike the ordinary
   *  low-frequency progress frames, this full stream exists only while a user has the child drill-in open. */
  | { type: 'tap'; tapId: string; userId: number; sessionId: string; history?: { before?: number; limit: number } }
  | { type: 'untap'; tapId: string }
  /** Drop the live record for a channel so the DAEMON can run that child's next turn itself (an idle
   *  continuation rehydrates from SQLite). Refused while that channel is busy. */
  | { type: 'release'; releaseId: string; channelId: string }
  /** Query work owned by runner-local plugin closures before replacing them on hot reload. */
  | { type: 'activity'; activityId: string }
  /** Stop every terminal process owned by one account before core deletes that account. */
  | { type: 'killAccountProcesses'; requestId: string; userId: number }
  /** The daemon's answer to a runner-originated host call. Errors are data so a rejected workflow
   *  expansion settles the tool call without crashing either IPC peer. */
  | { type: 'hostResult'; callId: string; result: HostRpcResult }
  | { type: 'hostError'; callId: string; message: string };

/** How a runner-side steer ended — see DelegatedTurnRunner.steer for what each verdict obliges the
 *  daemon to do next. */
export type RunnerSteerOutcome = 'delivered' | 'idle' | 'aborted';

const isSteerOutcome = (v: unknown): v is RunnerSteerOutcome =>
  v === 'delivered' || v === 'idle' || v === 'aborted';

export type RunnerToDaemon =
  | { type: 'ready'; buildId: string }
  /** The runner cannot serve turns at all (build skew, boot failure). It exits right after sending this. */
  | { type: 'fatal'; reason: string }
  | { type: 'progress'; turnId: string; event: DelegatedProgressEvent }
  /** A NESTED delegated edge inside the runner, mirrored into the daemon's registry so its abort tree,
   *  status and shutdown gate see the whole tree. The edge of the dispatched turn itself is NOT reported:
   *  the daemon registers that one synchronously before it forwards anything. */
  | { type: 'child'; parentSessionId: string; childSessionId: string; running: boolean }
  | { type: 'result'; turnId: string; reply: string }
  | { type: 'error'; turnId: string; message: string }
  | { type: 'released'; releaseId: string; busy: boolean }
  | { type: 'activity'; activityId: string; activeCount: number }
  | { type: 'accountProcessesKilled'; requestId: string; killed: number }
  /** The answer to a `steer` frame. `delivered` only once the message is confirmed in the child's
   *  context; `idle` when no streaming turn holds this channel here (the daemon then delivers the text
   *  itself); `aborted` when the delegation's abort fences fired while the steer waited. */
  | { type: 'steered'; steerId: string; outcome: RunnerSteerOutcome }
  | { type: 'tapped'; tapId: string; snapshot: BrainStreamSnapshot }
  | { type: 'tap-event'; tapId: string; event: BrainEvent }
  | { type: 'tap-error'; tapId: string; message: string }
  /** A reverse RPC is bound to a daemon-minted in-flight turn id. There is deliberately no session id in
   *  this frame: the daemon derives the caller session from its own pending-turn table. */
  | { type: 'hostCall'; callId: string; turnId: string; request: HostRpcRequest }
  /** What this runner sees of ITSELF, on a fixed interval. The event-loop p99 is the load signal nothing
   *  outside the process can observe — a busy runner and an idle one look identical from the daemon —
   *  and the RSS is what turns the memory ceiling from a guess into a measurement (see sizing.ts). The
   *  turn and session counts are the runner's own view, reported so a divergence from what the daemon
   *  believes is VISIBLE in /health rather than silent; the pool routes and admits from its own exact
   *  bookkeeping, never from a value that is one beat stale. */
  | { type: 'heartbeat'; loopP99Ms: number; activeTurns: number; sessions: number; rssBytes: number };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Parse a message from the daemon. A child never trusts its channel blindly — a malformed frame is
 *  dropped, not coerced. */
export function parseDaemonMessage(raw: unknown): DaemonToRunner | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.type === 'boot') {
    const buildId = str(v.buildId);
    const dbPath = str(v.dbPath);
    const p = v.project as Record<string, unknown> | undefined;
    const slug = str(p?.slug);
    const path = str(p?.path);
    if (!buildId || !dbPath || !p || !slug || !path || !Number.isSafeInteger(p.id)) return undefined;
    // A snapshot that does not parse is REFUSED along with the whole frame, not silently dropped: booting
    // without it would look identical from outside while composing a different tool list — and a tool list
    // is the prompt-cache key. Absent is fine; malformed is not.
    let mcp: McpBridgeSnapshot | undefined;
    if (v.mcp !== undefined) {
      mcp = parseMcpBridgeSnapshot(v.mcp);
      if (!mcp) return undefined;
    }
    return { type: 'boot', buildId, dbPath, project: { id: p.id as number, slug, path }, ...(mcp ? { mcp } : {}) };
  }
  if (v.type === 'turn') {
    const turnId = str(v.turnId);
    const text = str(v.text);
    if (!turnId || text === undefined || !v.request) return undefined;
    // The request itself is validated by parseDelegatedTurnRequest at the point of use, where a refusal
    // can be reported back against this turnId instead of vanishing as a dropped frame.
    return { type: 'turn', turnId, request: v.request as DelegatedTurnRequest, text };
  }
  if (v.type === 'abort') {
    const channelId = str(v.channelId);
    return channelId ? { type: 'abort', channelId } : undefined;
  }
  if (v.type === 'steer') {
    const steerId = str(v.steerId);
    const channelId = str(v.channelId);
    const text = str(v.text);
    // An empty steer text is refused with the frame: PI would queue it, the model would read a blank
    // user message, and the daemon would still be told 'delivered'.
    return steerId && channelId && text ? { type: 'steer', steerId, channelId, text } : undefined;
  }
  if (v.type === 'tap') {
    const tapId = str(v.tapId);
    const sessionId = str(v.sessionId);
    if (!tapId || !sessionId || !Number.isSafeInteger(v.userId) || (v.userId as number) <= 0) return undefined;
    let history: { before?: number; limit: number } | undefined;
    if (v.history !== undefined) {
      if (!v.history || typeof v.history !== 'object' || Array.isArray(v.history)) return undefined;
      const rawHistory = v.history as Record<string, unknown>;
      if (rawHistory.before !== undefined && (!Number.isSafeInteger(rawHistory.before) || (rawHistory.before as number) < 0)) return undefined;
      if (!Number.isSafeInteger(rawHistory.limit) || (rawHistory.limit as number) <= 0) return undefined;
      history = {
        ...(rawHistory.before !== undefined ? { before: rawHistory.before as number } : {}),
        limit: rawHistory.limit as number,
      };
    }
    return { type: 'tap', tapId, userId: v.userId as number, sessionId, ...(history ? { history } : {}) };
  }
  if (v.type === 'untap') {
    const tapId = str(v.tapId);
    return tapId ? { type: 'untap', tapId } : undefined;
  }
  if (v.type === 'release') {
    const releaseId = str(v.releaseId);
    const channelId = str(v.channelId);
    return releaseId && channelId ? { type: 'release', releaseId, channelId } : undefined;
  }
  if (v.type === 'activity') {
    const activityId = str(v.activityId);
    return activityId ? { type: 'activity', activityId } : undefined;
  }
  if (v.type === 'killAccountProcesses') {
    const requestId = str(v.requestId);
    return requestId && Number.isSafeInteger(v.userId) && (v.userId as number) > 0
      ? { type: 'killAccountProcesses', requestId, userId: v.userId as number }
      : undefined;
  }
  if (v.type === 'hostResult') {
    const callId = str(v.callId);
    const result = parseHostRpcResult(v.result);
    return callId && result ? { type: 'hostResult', callId, result } : undefined;
  }
  if (v.type === 'hostError') {
    const callId = str(v.callId);
    return callId ? { type: 'hostError', callId, message: str(v.message) ?? 'the daemon host RPC failed' } : undefined;
  }
  return undefined;
}

/** Parse a message from the runner. Same rule in reverse: the daemon must not crash on a frame from a
 *  child that is misbehaving or mid-crash. */
export function parseRunnerMessage(raw: unknown): RunnerToDaemon | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  switch (v.type) {
    case 'ready': {
      const buildId = str(v.buildId);
      return buildId ? { type: 'ready', buildId } : undefined;
    }
    case 'fatal': return { type: 'fatal', reason: str(v.reason) ?? 'unknown' };
    case 'progress': {
      const turnId = str(v.turnId);
      const event = parseProgressEvent(v.event);
      return turnId && event ? { type: 'progress', turnId, event } : undefined;
    }
    case 'child': {
      const parentSessionId = str(v.parentSessionId);
      const childSessionId = str(v.childSessionId);
      if (!parentSessionId || !childSessionId || typeof v.running !== 'boolean') return undefined;
      return { type: 'child', parentSessionId, childSessionId, running: v.running };
    }
    case 'result': {
      const turnId = str(v.turnId);
      const reply = str(v.reply);
      return turnId && reply !== undefined ? { type: 'result', turnId, reply } : undefined;
    }
    case 'error': {
      const turnId = str(v.turnId);
      return turnId ? { type: 'error', turnId, message: str(v.message) ?? 'sub-agent runner failed' } : undefined;
    }
    case 'released': {
      const releaseId = str(v.releaseId);
      return releaseId ? { type: 'released', releaseId, busy: v.busy === true } : undefined;
    }
    case 'activity': {
      const activityId = str(v.activityId);
      const activeCount = v.activeCount;
      return activityId && Number.isSafeInteger(activeCount) && (activeCount as number) >= 0
        ? { type: 'activity', activityId, activeCount: activeCount as number }
        : undefined;
    }
    case 'accountProcessesKilled': {
      const requestId = str(v.requestId);
      return requestId && Number.isSafeInteger(v.killed) && (v.killed as number) >= 0
        ? { type: 'accountProcessesKilled', requestId, killed: v.killed as number }
        : undefined;
    }
    case 'steered': {
      const steerId = str(v.steerId);
      // An unknown outcome is a dropped frame, not a coerced one: the daemon acts on this verdict
      // (deliver the text itself, or report the delegation aborted), so guessing would misdeliver.
      return steerId && isSteerOutcome(v.outcome) ? { type: 'steered', steerId, outcome: v.outcome } : undefined;
    }
    case 'tapped': {
      const tapId = str(v.tapId);
      const snapshot = v.snapshot as Record<string, unknown> | undefined;
      if (!tapId || !snapshot || snapshot.type !== 'snapshot' || typeof snapshot.cursor !== 'number'
        || !Array.isArray(snapshot.history) || !Array.isArray(snapshot.events)) return undefined;
      return { type: 'tapped', tapId, snapshot: snapshot as unknown as BrainStreamSnapshot };
    }
    case 'tap-event': {
      const tapId = str(v.tapId);
      const event = v.event as Record<string, unknown> | undefined;
      return tapId && event && typeof event.type === 'string'
        ? { type: 'tap-event', tapId, event: event as unknown as BrainEvent }
        : undefined;
    }
    case 'tap-error': {
      const tapId = str(v.tapId);
      return tapId ? { type: 'tap-error', tapId, message: str(v.message) ?? 'runner tap failed' } : undefined;
    }
    case 'hostCall': {
      const callId = str(v.callId);
      const turnId = str(v.turnId);
      const request = parseHostRpcRequest(v.request);
      return callId && turnId && request ? { type: 'hostCall', callId, turnId, request } : undefined;
    }
    case 'heartbeat': {
      // Every field must be a finite non-negative number: these drive spawn decisions, and a NaN sneaking
      // in would make every comparison false and quietly disable growth for the life of the daemon.
      const nums = [v.loopP99Ms, v.activeTurns, v.sessions, v.rssBytes];
      if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return undefined;
      return {
        type: 'heartbeat',
        loopP99Ms: v.loopP99Ms as number,
        activeTurns: v.activeTurns as number,
        sessions: v.sessions as number,
        rssBytes: v.rssBytes as number,
      };
    }
    default: return undefined;
  }
}

function parseProgressEvent(raw: unknown): DelegatedProgressEvent | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.type === 'session') {
    const sessionId = str(v.sessionId);
    return sessionId ? { type: 'session', sessionId } : undefined;
  }
  if (v.type === 'tool') {
    const name = str(v.name);
    if (!name) return undefined;
    return { type: 'tool', name, ...(typeof v.detail === 'string' ? { detail: v.detail } : {}) };
  }
  if (v.type === 'step') {
    if (typeof v.step !== 'number' || typeof v.maxSteps !== 'number') return undefined;
    const usage = v.usage;
    const carried = usage && typeof usage === 'object' && !Array.isArray(usage)
      ? { usage: usage as BrainUsage }
      : {};
    return { type: 'step', step: v.step, maxSteps: v.maxSteps, ...carried };
  }
  if (v.type === 'subagent') {
    const sessionId = str(v.sessionId);
    const status = v.status === 'running' || v.status === 'done' || v.status === 'error' ? v.status : undefined;
    return sessionId && status ? { type: 'subagent', sessionId, status } : undefined;
  }
  if (v.type === 'workflow') {
    const id = str(v.id);
    const toolCallId = str(v.toolCallId);
    const status = v.status === 'running' || v.status === 'done' || v.status === 'error' || v.status === 'cancelled'
      ? v.status : undefined;
    return id && toolCallId && status ? { type: 'workflow', id, toolCallId, status } : undefined;
  }
  return undefined;
}
