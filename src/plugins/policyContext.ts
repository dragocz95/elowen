import { AsyncLocalStorage } from 'node:async_hooks';
import type { Policy } from './policy.js';
import type { AskAnswer, AskQuestion, SubagentCompletion, SubagentUpdate, WorkflowCompletion, WorkflowUpdate } from '../brain/events.js';
import type { TurnPermissions } from '../brain/toolPermissions.js';
import type { MemoryRecallScope } from '../brain/memoryRecallScope.js';

/** Ask the current user one or more multiple-choice questions and await their pick(s). Bound per-turn by
 *  BrainService (it knows which conversation's clients to emit to and where to park the answer). */
export type Elicitor = (questions: AskQuestion[]) => Promise<AskAnswer[]>;

/** Push a display card to the current conversation's clients (see `ctx.emitCard`). Bound per-turn by
 *  BrainService to the active conversation's card registry + listener set. */
export type CardEmitter = (card: unknown) => void;

/** Push live sub-agent progress to the current conversation's clients as `subagent` BrainEvents.
 *  Bound per-turn by BrainService (see `ctx.subagentEmitter`). */
export type SubagentEmitter = (update: SubagentUpdate) => boolean | void;
export type SubagentCompletionEmitter = (completion: SubagentCompletion) => void;

/** Push a live sub-agent WORKFLOW snapshot to the current conversation's clients as `workflow`
 *  BrainEvents. Bound per-turn by BrainService (see `ctx.workflowEmitter`); captured once by the
 *  workflow engine before it schedules nodes, since node turns run in their own scope. */
export type WorkflowEmitter = (update: WorkflowUpdate) => void;

/** Host-only durable completion sink for a detached/background workflow — mirror of
 *  SubagentCompletionEmitter. Captured once by the workflow engine before it schedules nodes. */
export type WorkflowCompletionEmitter = (completion: WorkflowCompletion) => void;

/** The provider entry + model the current turn's session runs on (see `ctx.currentModel`). `thinkingLevel`
 *  is the turn's effective reasoning effort (empty/undefined when the model has no reasoning ladder), so a
 *  delegating plugin can default its child to the SAME reasoning effort as the parent, not the model default. */
export interface TurnModel { provider?: string; model: string; thinkingLevel?: string }

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
  /** The turn belongs to an account that ADMINISTERS this instance — the configured operator or any
   *  account with `users.is_admin` — through their own chat, their linked platform account, or their own
   *  automation (cron). Surfaces that need instance authority (the raw Discord API, MCP instance and
   *  stdio servers) gate on THIS, never on `admin`, so an admin-role stranger cannot reach them. The bit
   *  is minted from the linked ACCOUNT, never from a room role. See src/shared/instanceOperator.ts. */
  owner: boolean;
  /** WHERE this turn is happening, as one value a plugin can branch on without re-deriving it from a
   *  session id (which cannot distinguish a private DM from a shared room):
   *    - `own`       the account's own authenticated Elowen chat (web dock / CLI)
   *    - `direct`    a 1:1 platform chat with one verified account
   *    - `shared`    a platform room other people can read
   *    - `delegated` a sub-agent turn, which has no conversation of its own
   *  A tool that creates something OWNED by a person should require `own` or `direct`; `shared` means the
   *  sender is one of several and per-account state must not be assumed. */
  conversation: 'own' | 'direct' | 'shared' | 'delegated';
}

/** Who this turn belongs to, as one stable string — the ACCOUNT when there is one, else the raw platform
 *  sender. Two senders in the SAME shared channel share a session but never a principal, which is what
 *  lets a durable object record which of them created it (see DelegatedExecutionScope.spawnedBy).
 *  Undefined when the turn carries no identity at all; every caller must then fail closed rather than
 *  treat "unknown" as a match. */
export function turnPrincipal(identity: TurnIdentity | null | undefined): string | undefined {
  if (!identity) return undefined;
  if (Number.isSafeInteger(identity.elowenUserId)) return `elowen:${identity.elowenUserId}`;
  const platform = identity.platform.trim();
  const userId = identity.userId.trim();
  return platform && userId ? `${platform}:${userId}` : undefined;
}

/** Per-turn tool access — the SINGLE abstraction every source resolves into, so tool gating has one shape
 *  everywhere. `allow` (when set) is an allow-list: only those plugin tools are permitted — the grant an
 *  admin gave the account that is writing, or a delegated child's captured scope. `deny` is a deny-list:
 *  those plugin tools are withheld (the account's `disabled_tools`, plus any grant-gated plugin it does
 *  not hold). Both may be set; deny is applied after allow. Undefined ToolPolicy = no restriction.
 *
 *  A platform ROLE is deliberately not a source here. Authority belongs to a verified account, and a role
 *  is not an identity — see buildRoleAccess in the shared plugin package. */
export interface ToolPolicy { allow?: Set<string>; deny?: Set<string> }

/** Whether an entry of a ToolPolicy list covers this tool name. Exact by default; a trailing `*` makes it
 *  a prefix. The wildcard exists for tool families whose members are only known at runtime — bridged MCP
 *  tools are named `mcp__<server>__<tool>`, so no static list can enumerate them. Applied to `deny` as
 *  well as `allow`, because a wildcard that could only ever widen would be a way to slip past a deny. */
export function listCovers(list: Iterable<string>, name: string): boolean {
  for (const entry of list) {
    if (entry === name) return true;
    if (entry.endsWith('*') && name.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

/** Narrow one allow-list by another, honouring a trailing `*` ON BOTH SIDES. The result is what a holder
 *  of `by` may still reach out of `list` — never more, so it is safe wherever an allow-list is intersected
 *  (a delegated preset against the caller's grant, a captured child scope against the account's current
 *  one). A plain `Array.includes`/`Set.has` intersection is wrong in two directions here, and both occur
 *  in production: the column default is the `*` marker, so pre-migration EVERY non-admin grant is
 *  literally `['*']` and an exact intersection yields nothing at all; and `mcp__*` — the only way to name
 *  a bridged MCP family, whose members exist only at runtime — can never equal a concrete granted name.
 *
 *  An entry survives whole when `by` covers it. A WILDCARD entry `by` does not cover contributes instead
 *  the entries of `by` that IT covers, which is the narrowest honest answer: `mcp__*` narrowed by
 *  `['mcp__github__issue']` is `['mcp__github__issue']`, not `mcp__*` (too wide) and not nothing (the
 *  bug). Everything else drops. */
export function narrowToolAllowList(list: Iterable<string>, by: Iterable<string>): string[] {
  const limit = [...by];
  const out: string[] = [];
  for (const entry of list) {
    if (listCovers(limit, entry)) { out.push(entry); continue; }
    if (!entry.endsWith('*')) continue;
    for (const held of limit) if (listCovers([entry], held)) out.push(held);
  }
  return [...new Set(out)];
}

/** Whether a plugin tool name is permitted under a ToolPolicy (undefined policy → always permitted). */
export function toolPermitted(name: string, tp: ToolPolicy | undefined): boolean {
  if (!tp) return true;
  if (tp.allow && !listCovers(tp.allow, name)) return false;
  if (tp.deny && listCovers(tp.deny, name)) return false;
  return true;
}

/** Which composed tools belong to individual ACCOUNTS rather than to the instance, paired with the account
 *  the current turn may reach them as. Set only where one session composes several accounts' owner-scoped
 *  tools — a shared room (see PluginRegistry.sharedRoomToolOwners). A name maps to EVERY account that owns a
 *  version of it: two colleagues whose personal MCP servers happen to expose the same tool are served from
 *  one registered definition that dispatches on the writer, so both of them own that name. */
export interface PersonalToolOwnership {
  owners: ReadonlyMap<string, ReadonlySet<number>>;
  contributionUserId: number | null;
}

/** Whether `name` is one account's personal tool that the CURRENT contribution owner does not own — the one
 *  predicate every ownership decision reads, so the visibility pass, the execute gate, the deferred-tool
 *  awareness block and ToolSearch cannot reach different conclusions about whose server a name belongs to.
 *  Instance-wide tools (absent from the map) belong to everybody and are never withheld by ownership. */
export function toolOwnedByOtherAccount(name: string, personal: PersonalToolOwnership | undefined): boolean {
  const owners = personal?.owners.get(name);
  if (!owners) return false;
  return personal!.contributionUserId === null || !owners.has(personal!.contributionUserId);
}

/** The owner's work mode for this turn. Declared here rather than imported from the brain so the plugin
 *  layer keeps its one-directional dependency; the brain's TurnMode is structurally identical. */
export type TurnWorkMode = 'build' | 'plan' | 'workflow';

interface TurnScope { policy?: Policy; workDir?: string; sessionId?: string; deliveryTarget?: string; identity?: TurnIdentity; elicit?: Elicitor; emitCard?: CardEmitter; emitSubagent?: SubagentEmitter; emitSubagentCompletion?: SubagentCompletionEmitter; emitWorkflow?: WorkflowEmitter; emitWorkflowCompletion?: WorkflowCompletionEmitter; toolPolicy?: ToolPolicy; permissions?: TurnPermissions; model?: TurnModel; mode?: TurnWorkMode; memoryRecallScope?: MemoryRecallScope; contributionUserId?: number | null }

/** pi tools have no per-call session context, so a plugin tool can't be told which user's policy applies
 *  through its arguments. We carry the resolved Policy (+ the sender's identity + their effective tool
 *  access) on an AsyncLocalStorage (the Node equivalent of a per-request security contextvar): BrainService
 *  runs each prompt inside `runWithPolicy`, and a plugin tool reads `currentPolicy()`/`currentIdentity()`/
 *  `currentToolPolicy()` at execution time. */
const store = new AsyncLocalStorage<TurnScope>();

/** Run `fn` (a brain prompt turn) with `policy` established for any plugin tool it invokes. `opts`
 *  carries the sender's identity, a turn-bound elicitor/card-emitter, and the effective tool policy —
 *  all read at tool-execute time via the `current*()` accessors. */
export function runWithPolicy<T>(policy: Policy, fn: () => T, opts?: { workDir?: string; sessionId?: string; deliveryTarget?: string; identity?: TurnIdentity; elicit?: Elicitor; emitCard?: CardEmitter; emitSubagent?: SubagentEmitter; emitSubagentCompletion?: SubagentCompletionEmitter; emitWorkflow?: WorkflowEmitter; emitWorkflowCompletion?: WorkflowCompletionEmitter; toolPolicy?: ToolPolicy; permissions?: TurnPermissions; model?: TurnModel; mode?: TurnWorkMode; memoryRecallScope?: MemoryRecallScope; contributionUserId?: number | null }): T {
  return store.run({ policy, workDir: opts?.workDir, sessionId: opts?.sessionId, deliveryTarget: opts?.deliveryTarget, identity: opts?.identity, elicit: opts?.elicit, emitCard: opts?.emitCard, emitSubagent: opts?.emitSubagent, emitSubagentCompletion: opts?.emitSubagentCompletion, emitWorkflow: opts?.emitWorkflow, emitWorkflowCompletion: opts?.emitWorkflowCompletion, toolPolicy: opts?.toolPolicy, permissions: opts?.permissions, model: opts?.model, mode: opts?.mode, memoryRecallScope: opts?.memoryRecallScope, contributionUserId: opts?.contributionUserId }, fn);
}

/** Run `fn` with only the caller's IDENTITY established — the shape an authenticated HTTP request has.
 *  Deliberately NOT a turn: no Policy, no tool policy, no session id, so `isAdminSession()` stays false
 *  and a path guard keeps refusing. It exists so a plugin's API handler can answer "which account is
 *  this?" through the same `ctx.currentIdentity()` its tools use, instead of every plugin inventing a
 *  second identity channel out of the raw request. */
export function runWithIdentity<T>(identity: TurnIdentity, fn: () => T): T {
  return store.run({ identity }, fn);
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

/** The categories recall may use in this turn. Undefined is reserved for legacy callers that do not
 * establish a prompt scope; real conversation paths always install an explicit, fail-closed scope. */
export function currentMemoryRecallScope(): MemoryRecallScope | undefined {
  return store.getStore()?.memoryRecallScope;
}

/** The sender identity of the current prompt turn, or null when none was established. */
export function currentIdentity(): TurnIdentity | null {
  return store.getStore()?.identity ?? null;
}

/** WHOSE personal contributions this turn may reach — see `contributionOwnerForSession`, which is the one
 *  place the answer is decided and the only thing that writes this. A plugin holding owner-scoped content
 *  (the skills plugin's personal skill sets) resolves the caller through THIS, not through
 *  `currentIdentity().elowenUserId`: the two agree for an ordinary room turn, but they part company for a
 *  delegated child, whose identity deliberately carries no account while its contributions are inherited
 *  from the turn that spawned it. Reading identity there would tell the model about a skill and then refuse
 *  to load it. Null (or undefined, outside a turn) means the instance-wide set and nothing personal. */
export function currentContributionUserId(): number | null {
  return store.getStore()?.contributionUserId ?? null;
}

/** The persisted brain-session id the current prompt turn runs in (`brain-…`), or undefined outside a
 *  prompt turn / for transports that wire none. Lets a plugin bind scheduled work back to the exact
 *  conversation it was created from (e.g. a cron wake-up replying where it was scheduled). */
export function currentSessionId(): string | undefined {
  return store.getStore()?.sessionId;
}

/** Opaque outbound destination for the current direct platform conversation. Plugins may persist and
 * return it to the host, but must not parse or construct it. Undefined for owner chats and shared rooms. */
export function currentDeliveryTarget(): string | undefined {
  return store.getStore()?.deliveryTarget;
}

/** An opaque token identifying THIS prompt turn, or undefined outside one. `runWithPolicy` builds a fresh
 *  scope object per turn, so object identity already is the turn boundary — a tool that must budget "per
 *  turn" holds it in a WeakMap keyed on this rather than inventing its own notion of when a turn ended.
 *  The session id cannot serve: it stays the same for the whole conversation. */
export function currentTurnToken(): object | undefined {
  return store.getStore();
}

/** The effective tool policy for the current turn (used by the plugin-tool execute-time gate), or
 *  undefined when none was established (→ every plugin tool permitted). */
export function currentToolPolicy(): ToolPolicy | undefined {
  return store.getStore()?.toolPolicy;
}

/** The owner's work mode for the current turn, or undefined where none is established (channel, cron and
 *  sub-agent turns have no mode). Read by the delegation path so a turn spent PLANNING can only ever
 *  spawn a read-only child. */
export function currentTurnMode(): TurnWorkMode | undefined {
  return store.getStore()?.mode;
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

/** The turn-bound workflow completion sink, or null outside a prompt turn (or a transport that wired
 *  none). Captured ONCE by the workflow engine before it schedules nodes — a detached/background
 *  workflow delivers its summary through this. */
export function currentWorkflowCompletionEmitter(): WorkflowCompletionEmitter | null {
  return store.getStore()?.emitWorkflowCompletion ?? null;
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
