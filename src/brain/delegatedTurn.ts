import type { Policy } from '../plugins/policy.js';
import type { TurnIdentity } from '../plugins/policyContext.js';
import type { ChannelSendOpts } from './channels.js';
import type { BrainEvent, BrainUsage } from './events.js';
import { delegatedToolPolicy, normalizeDelegatedExecutionScope, type DelegatedExecutionScope } from './delegatedScope.js';
import type { HostRpcMethod } from '../subagent/hostRpc.js';
import type { BrainStreamSnapshot } from './session/liveEventReplay.js';

/** Everything a delegated child's turn needs that a SECOND PROCESS could not derive for itself.
 *
 *  This is deliberately the exact input of {@link delegatedChannelSendOpts}, and that function is the only
 *  place a delegated `ChannelSendOpts` is built — by the daemon for an in-process turn and by the sub-agent
 *  runner for a forwarded one. One builder, one prompt: a field that travelled would otherwise have to be
 *  re-assembled on the far side, and a delegated child's system prompt is the prompt-cache key, so a single
 *  byte of drift silently re-bills the whole prefix at full price.
 *
 *  Every member is JSON-serializable BY CONSTRUCTION. The three values that are NOT — the `Policy` closure
 *  over the project store, the `ToolPolicy` Sets and the `TurnIdentity` — are deliberately absent and are
 *  re-derived from `delegatedAccess`, which is the authoritative boundary and already round-trips through
 *  SQLite. `subagentWirePayload.test.ts` pins that: what crosses survives a JSON round-trip and carries no
 *  closure. */
export interface DelegatedTurnRequest {
  /** The channel key the subagent plugin minted (`subagent-sub-dlg-…`), NOT the session id. */
  channelId: string;
  ownerUserId: number;
  /** The durable delegating conversation. Required — a delegated turn without one is refused. */
  parentSessionId: string;
  /** The immutable boundary minted by the delegating turn; policy/toolPolicy/identity all come from it. */
  delegatedAccess: DelegatedExecutionScope;
  scheduled: boolean;
  model?: { provider?: string; model?: string };
  thinkingLevel?: string;
  fast?: boolean;
  /** The delegating turn's working directory, inherited so the child's tools resolve relative paths
   *  against the same project the parent runs in. */
  clientCwd?: string;
  idleRolloverMs?: number;
}

export interface DelegatedTurnDeps {
  /** Build a Policy from an explicit project-id set. Same resolver the daemon's platform turns use. */
  policyForProjects?: (projectIds: number[]) => Policy;
  identity: { forDelegatedTurn(scope: DelegatedExecutionScope, ownerUserId: number): TurnIdentity };
}

/** THE delegated `ChannelSendOpts`. `policy`, `toolPolicy` and `identity` are re-derived here from the
 *  captured scope rather than carried, because none of the three survives a process boundary: the policy
 *  closes over the project store, the tool policy holds Sets, and the identity is minted against the live
 *  owner check. Everything downstream (ChannelSessionService.delegatedExecution) re-validates that the
 *  three agree with the scope, so a re-derivation that drifted fails closed instead of running wide.
 *
 *  `promptAppend` is read off the scope rather than passed: the orchestrator packs the child's prompt
 *  sections INTO the scope before minting it, so the scope's copy is the authoritative one — and
 *  `samePromptAppend` in the channel service refuses anything else. */
export function delegatedChannelSendOpts(
  req: DelegatedTurnRequest,
  deps: DelegatedTurnDeps,
  onEvent?: (e: BrainEvent) => void,
): ChannelSendOpts {
  const scope = req.delegatedAccess;
  const policy: Policy = scope.admin
    ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
    : deps.policyForProjects?.(scope.projectIds)
      ?? { allowedProjectIds: new Set(scope.projectIds), allowedPaths: () => [] };
  return {
    channelId: req.channelId,
    ownerUserId: req.ownerUserId,
    policy,
    ...(scope.promptAppend ? { promptAppend: scope.promptAppend } : {}),
    trusted: scope.admin, // admin scope → trusted-channel, never owner-chat
    scheduled: req.scheduled,
    ...(req.model ? { model: req.model } : {}),
    ...(req.thinkingLevel !== undefined ? { thinkingLevel: req.thinkingLevel } : {}),
    // `fast` is tri-state downstream (undefined = "leave the session's profile alone"), so an absent
    // request field must stay absent rather than collapse to false.
    ...(req.fast !== undefined ? { fast: req.fast } : {}),
    parentSessionId: req.parentSessionId,
    delegatedAccess: scope,
    ...(req.clientCwd !== undefined ? { clientCwd: req.clientCwd } : {}),
    ...(req.idleRolloverMs !== undefined ? { idleRolloverMs: req.idleRolloverMs } : {}),
    toolPolicy: delegatedToolPolicy(scope),
    identity: deps.identity.forDelegatedTurn(scope, req.ownerUserId),
    ...(onEvent ? { onEvent } : {}),
  };
}

/** Something that can execute a delegated turn OUTSIDE this process — the forked sub-agent runner (see
 *  SubagentRunnerHost). Declared here, with the request it consumes, so the brain's wiring never has to
 *  import the runner implementation: a process without one simply omits it and every delegated turn stays
 *  in-process, which is exactly what the runner process itself does. */
export interface DelegatedTurnRunner {
  run(request: DelegatedTurnRequest, text: string, onEvent?: (e: BrainEvent) => void): Promise<string>;
  /** Abort the runner's live session for a channel. The abort TREE stays in the daemon; this only reaches
   *  the process that actually holds the PI session. */
  abort(channelId: string): void;
  /** Steer a parent's follow-up into a child turn RUNNING in the runner (the daemon has already authorized
   *  it). `delivered` = the message provably entered the child's context over there; `idle` = the runner
   *  holds no streaming turn for that channel (or its turn ended first, with the stale queue copy removed),
   *  so the caller falls back to running the follow-up itself; `aborted` = the delegation's abort fences
   *  fired while the steer waited. */
  steer(channelId: string, text: string): Promise<{ outcome: 'delivered' | 'idle' | 'aborted' }>;
  /** Atomically snapshot and follow a delegated session held in the runner. The daemon has already checked
   *  ownership. Undefined means this runner does not hold that session, so the caller uses its local tap. */
  tapSessionSnapshot?(
    userId: number,
    sessionId: string,
    listener: (event: BrainEvent) => void,
    history?: { before?: number; limit: number },
  ): Promise<{ off: () => void; snapshot: BrainStreamSnapshot } | undefined>;
  /** Ask the runner to drop its live record for a channel so the caller can run that child's next turn
   *  itself (an idle continuation rehydrates from SQLite). `busy` = still working on it. */
  release(channelId: string): Promise<{ busy: boolean }>;
  /** Count work owned by runner-local plugin closures, including gaps between delegated turns. A hot plugin
   *  reload must drain this before replacing those closures. Absent means the runner predates this seam. */
  activeCount?(): Promise<number>;
  /** Tear the runner down (plugin reload, shutdown). In-flight turns settle as interrupted. */
  reset(reason: string): void;
  /** Can this runner take work AT ALL right now? The pool answers false when the operator has sized it to
   *  zero, so the dispatcher reports `in-process` and routes there directly — rather than failing a turn
   *  per delegation and logging a fallback warning each time. Absent ⇒ assumed usable. */
  usable?(): boolean;
  /** Whether remote turns have a live reverse channel for this host operation. Absent is an old/unwired
   *  runner and callers must withhold the corresponding tool rather than hand out a broken capability. */
  supportsHostRpc?(method: HostRpcMethod): boolean;
  /** Broadcast the daemon's shutdown drain latch so turns over there park at their next step boundary
   *  too (see stepDrain.ts). Absent means the runner predates this seam. */
  beginDrain?(): void;
  /** How many turns in the runner(s) are still mid-step — the remote half of the step-boundary drain. */
  midStepWork?(): Promise<number>;
}

/** The runner could not be STARTED. Distinct from a turn that failed inside a healthy runner: nothing ran
 *  yet, so the dispatcher may safely fall back to executing this one turn in-process. */
export class SubagentRunnerUnavailable extends Error {}

/** The ONLY child-progress shapes that cross the runner boundary.
 *
 *  Deliberately three low-frequency events, mirroring what the delegating plugin actually consumes (the
 *  child's session id, its tool starts, its step token usage). Text deltas, tool-argument deltas and
 *  transcript events are excluded BY THE TYPE: re-amplifying a child's whole stream across an IPC channel
 *  would undo the very event-loop pressure this runner exists to remove. */
export type DelegatedProgressEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'step'; step: number; maxSteps: number; usage?: BrainUsage };

/** Narrow a child's event onto the wire shape, or undefined for everything that must not cross. */
export function toDelegatedProgress(e: BrainEvent): DelegatedProgressEvent | undefined {
  if (e.type === 'session') return { type: 'session', sessionId: e.sessionId };
  if (e.type === 'tool') return { type: 'tool', name: e.name, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
  if (e.type === 'step') return { type: 'step', step: e.step, maxSteps: e.maxSteps, ...(e.usage ? { usage: e.usage } : {}) };
  return undefined;
}

/** Rebuild the daemon-side event replayed into the delegating turn's emitter. */
export function fromDelegatedProgress(e: DelegatedProgressEvent): BrainEvent {
  return e;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Validate a request that arrived over IPC. Internal traffic is still parsed like persisted JSON: a
 *  delegated turn whose boundary does not normalize must be REFUSED, never run under an ambient policy. */
export function parseDelegatedTurnRequest(raw: unknown): DelegatedTurnRequest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const channelId = str(v.channelId);
  const parentSessionId = str(v.parentSessionId);
  const scope = normalizeDelegatedExecutionScope(v.delegatedAccess);
  if (!channelId || !parentSessionId || !scope) return undefined;
  if (!Number.isSafeInteger(v.ownerUserId) || (v.ownerUserId as number) <= 0) return undefined;
  if (typeof v.scheduled !== 'boolean') return undefined;
  let model: DelegatedTurnRequest['model'];
  if (v.model !== undefined) {
    if (!v.model || typeof v.model !== 'object' || Array.isArray(v.model)) return undefined;
    const m = v.model as Record<string, unknown>;
    if (m.provider !== undefined && typeof m.provider !== 'string') return undefined;
    if (m.model !== undefined && typeof m.model !== 'string') return undefined;
    model = {
      ...(typeof m.provider === 'string' ? { provider: m.provider } : {}),
      ...(typeof m.model === 'string' ? { model: m.model } : {}),
    };
  }
  if (v.thinkingLevel !== undefined && typeof v.thinkingLevel !== 'string') return undefined;
  if (v.fast !== undefined && typeof v.fast !== 'boolean') return undefined;
  if (v.clientCwd !== undefined && typeof v.clientCwd !== 'string') return undefined;
  // JSON has no Infinity: the plugin already pins its "never roll over" value to MAX_SAFE_INTEGER for
  // exactly this reason, so anything non-finite arriving here is corruption, not a legitimate sentinel.
  if (v.idleRolloverMs !== undefined && (typeof v.idleRolloverMs !== 'number' || !Number.isFinite(v.idleRolloverMs))) return undefined;
  return {
    channelId,
    ownerUserId: v.ownerUserId as number,
    parentSessionId,
    delegatedAccess: scope,
    scheduled: v.scheduled,
    ...(model ? { model } : {}),
    ...(typeof v.thinkingLevel === 'string' ? { thinkingLevel: v.thinkingLevel } : {}),
    ...(typeof v.fast === 'boolean' ? { fast: v.fast } : {}),
    ...(typeof v.clientCwd === 'string' ? { clientCwd: v.clientCwd } : {}),
    ...(typeof v.idleRolloverMs === 'number' ? { idleRolloverMs: v.idleRolloverMs } : {}),
  };
}
