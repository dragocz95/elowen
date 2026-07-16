import { AsyncLocalStorage } from 'node:async_hooks';
import type { Policy } from './policy.js';
import type { AskAnswer, AskQuestion, SubagentCompletion, SubagentUpdate, WorkflowUpdate } from '../brain/events.js';
import type { TurnPermissions } from '../brain/toolPermissions.js';

/** Ask the current user one or more multiple-choice questions and await their pick(s). Bound per-turn by
 *  BrainService (it knows which conversation's clients to emit to and where to park the answer). */
export type Elicitor = (questions: AskQuestion[]) => Promise<AskAnswer[]>;

/** Push a display card to the current conversation's clients (see `ctx.emitCard`). Bound per-turn by
 *  BrainService to the active conversation's card registry + listener set. */
export type CardEmitter = (card: unknown) => void;

/** Push live sub-agent progress to the current conversation's clients as `subagent` BrainEvents.
 *  Bound per-turn by BrainService (see `ctx.subagentEmitter`). */
export type SubagentEmitter = (update: SubagentUpdate) => void;
export type SubagentCompletionEmitter = (completion: SubagentCompletion) => void;

/** Push a live sub-agent WORKFLOW snapshot to the current conversation's clients as `workflow`
 *  BrainEvents. Bound per-turn by BrainService (see `ctx.workflowEmitter`); captured once by the
 *  workflow engine before it schedules nodes, since node turns run in their own scope. */
export type WorkflowEmitter = (update: WorkflowUpdate) => void;

/** The provider entry + model the current turn's session runs on (see `ctx.currentModel`). */
export interface TurnModel { provider?: string; model: string }

/** Who is driving the current prompt turn. Plugins that persist per-user state (long-term memory)
 *  key it on this: a linked platform sender resolves to their Elowen username, an unknown sender to
 *  `<platform>:<platformUserId>`, the owner to whatever identity the plugin's config anchors. */
export interface TurnIdentity {
  platform: string;
  userId: string;
  /** The Elowen ACCOUNT id behind this turn, when there is one: the user themselves in their own chat, or
   *  the linked account a platform sender is verified as. Undefined for an unlinked/anonymous sender.
   *  Distinct from `userId`, which for a platform turn is the raw platform id (e.g. a Discord id) — so
   *  per-account state (private long-term memory) keys on THIS, never on the ambiguous `userId`. */
  elowenUserId?: number;
  /** Set when the sender is (or linked to) a registered Elowen account. */
  elowenUsername?: string;
  /** Full-access (all-access policy) turn — unlocks project-scoped power tools. NOT sufficient for
   *  owner-only surfaces: a foreign platform member mapped to an admin role also lands here. */
  admin: boolean;
  /** The turn is genuinely the instance OPERATOR — their own chat, their linked platform account, or
   *  their own automation (cron). Owner-only surfaces (private long-term memory, the raw Discord API)
   *  gate on THIS, never on `admin`, so an admin-role stranger can't reach the operator's private state. */
  owner: boolean;
}

/** Per-turn tool access — the SINGLE abstraction both sources (a user's Elowen account and a platform
 *  role policy) resolve into, so tool gating has one shape everywhere. `allow` (when set) is an
 *  allow-list: only those plugin tools are permitted (a role's tool allowlist for an unlinked sender).
 *  `deny` is a deny-list: those plugin tools are withheld (a user's own `disabled_tools`). Both may be
 *  set; deny is applied after allow. Undefined ToolPolicy = no restriction (every plugin tool). */
export interface ToolPolicy { allow?: Set<string>; deny?: Set<string> }

/** Whether a plugin tool name is permitted under a ToolPolicy (undefined policy → always permitted). */
export function toolPermitted(name: string, tp: ToolPolicy | undefined): boolean {
  if (!tp) return true;
  if (tp.allow && !tp.allow.has(name)) return false;
  if (tp.deny && tp.deny.has(name)) return false;
  return true;
}

interface TurnScope { policy: Policy; workDir?: string; sessionId?: string; identity?: TurnIdentity; elicit?: Elicitor; emitCard?: CardEmitter; emitSubagent?: SubagentEmitter; emitSubagentCompletion?: SubagentCompletionEmitter; emitWorkflow?: WorkflowEmitter; toolPolicy?: ToolPolicy; permissions?: TurnPermissions; model?: TurnModel }

/** pi tools have no per-call session context, so a plugin tool can't be told which user's policy applies
 *  through its arguments. We carry the resolved Policy (+ the sender's identity + their effective tool
 *  access) on an AsyncLocalStorage (the Node equivalent of a per-request security contextvar): BrainService
 *  runs each prompt inside `runWithPolicy`, and a plugin tool reads `currentPolicy()`/`currentIdentity()`/
 *  `currentToolPolicy()` at execution time. */
const store = new AsyncLocalStorage<TurnScope>();

/** Run `fn` (a brain prompt turn) with `policy` established for any plugin tool it invokes. `opts`
 *  carries the sender's identity, a turn-bound elicitor/card-emitter, and the effective tool policy —
 *  all read at tool-execute time via the `current*()` accessors. */
export function runWithPolicy<T>(policy: Policy, fn: () => T, opts?: { workDir?: string; sessionId?: string; identity?: TurnIdentity; elicit?: Elicitor; emitCard?: CardEmitter; emitSubagent?: SubagentEmitter; emitSubagentCompletion?: SubagentCompletionEmitter; emitWorkflow?: WorkflowEmitter; toolPolicy?: ToolPolicy; permissions?: TurnPermissions; model?: TurnModel }): T {
  return store.run({ policy, workDir: opts?.workDir, sessionId: opts?.sessionId, identity: opts?.identity, elicit: opts?.elicit, emitCard: opts?.emitCard, emitSubagent: opts?.emitSubagent, emitSubagentCompletion: opts?.emitSubagentCompletion, emitWorkflow: opts?.emitWorkflow, toolPolicy: opts?.toolPolicy, permissions: opts?.permissions, model: opts?.model }, fn);
}

/** The Policy in effect for the current prompt turn, or undefined outside a `runWithPolicy` scope. */
export function currentPolicy(): Policy | undefined {
  return store.getStore()?.policy;
}

/** The project path the current turn's session is bound to (a task worker's checkout), or undefined for
 *  an unbound session. Established fresh by each `runWithPolicy` scope, so a directory the agent moved
 *  to during one run can never carry into the next — every run starts back at the bound project path. */
export function currentWorkDir(): string | undefined {
  return store.getStore()?.workDir;
}

/** The sender identity of the current prompt turn, or null when none was established. */
export function currentIdentity(): TurnIdentity | null {
  return store.getStore()?.identity ?? null;
}

/** The persisted brain-session id the current prompt turn runs in (`brain-…`), or undefined outside a
 *  prompt turn / for transports that wire none. Lets a plugin bind scheduled work back to the exact
 *  conversation it was created from (e.g. a cron wake-up replying where it was scheduled). */
export function currentSessionId(): string | undefined {
  return store.getStore()?.sessionId;
}

/** The effective tool policy for the current turn (used by the plugin-tool execute-time gate), or
 *  undefined when none was established (→ every plugin tool permitted). */
export function currentToolPolicy(): ToolPolicy | undefined {
  return store.getStore()?.toolPolicy;
}

/** The granular tool-permission context of the current turn (rules + effective YOLO + the approval
 *  channel), or undefined when none was established — the execute-time gate is then inert, preserving
 *  the pre-permission behaviour (task workers, tests). */
export function currentTurnPermissions(): TurnPermissions | undefined {
  return store.getStore()?.permissions;
}

/** The turn-bound elicitor for `ctx.askUser`, or null outside a prompt turn (or when the transport
 *  driving the turn wired none — e.g. non-interactive worker sessions). */
export function currentElicitor(): Elicitor | null {
  return store.getStore()?.elicit ?? null;
}

/** The turn-bound sub-agent progress emitter, or null outside a prompt turn (or a transport that wired
 *  none — e.g. worker/cron sessions). Captured ONCE by the delegating tool before it spawns the child:
 *  callbacks fired from the child's own turn run inside the CHILD's scope, where this would resolve to
 *  nothing useful. */
export function currentSubagentEmitter(): SubagentEmitter | null {
  return store.getStore()?.emitSubagent ?? null;
}

export function currentSubagentCompletionEmitter(): SubagentCompletionEmitter | null {
  return store.getStore()?.emitSubagentCompletion ?? null;
}

/** The turn-bound workflow snapshot emitter, or null outside a prompt turn (or a transport that wired
 *  none). Captured ONCE by the workflow engine before it schedules nodes — node turns run in the
 *  child's scope, where this would no longer resolve to the originating conversation. */
export function currentWorkflowEmitter(): WorkflowEmitter | null {
  return store.getStore()?.emitWorkflow ?? null;
}

/** The provider+model the current turn's session runs on, or null outside a prompt turn — lets a
 *  delegating plugin default its child to "the same model as me". */
export function currentTurnModel(): TurnModel | null {
  return store.getStore()?.model ?? null;
}

/** The turn-bound card emitter for `ctx.emitCard`, or null outside a prompt turn (or a transport that
 *  wired none). */
export function currentCardEmitter(): CardEmitter | null {
  return store.getStore()?.emitCard ?? null;
}
