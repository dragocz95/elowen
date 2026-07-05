import { AsyncLocalStorage } from 'node:async_hooks';
import type { Policy } from './policy.js';
import type { AskAnswer, AskQuestion } from '../brain/events.js';

/** Ask the current user one or more multiple-choice questions and await their pick(s). Bound per-turn by
 *  BrainService (it knows which conversation's clients to emit to and where to park the answer). */
export type Elicitor = (questions: AskQuestion[]) => Promise<AskAnswer[]>;

/** Push a display card to the current conversation's clients (see `ctx.emitCard`). Bound per-turn by
 *  BrainService to the active conversation's card registry + listener set. */
export type CardEmitter = (card: unknown) => void;

/** Who is driving the current prompt turn. Plugins that persist per-user state (long-term memory)
 *  key it on this: a linked platform sender resolves to their Orca username, an unknown sender to
 *  `<platform>:<platformUserId>`, the owner to whatever identity the plugin's config anchors. */
export interface TurnIdentity {
  platform: string;
  userId: string;
  /** The Orca ACCOUNT id behind this turn, when there is one: the user themselves in their own chat, or
   *  the linked account a platform sender is verified as. Undefined for an unlinked/anonymous sender.
   *  Distinct from `userId`, which for a platform turn is the raw platform id (e.g. a Discord id) — so
   *  per-account state (private long-term memory) keys on THIS, never on the ambiguous `userId`. */
  orcaUserId?: number;
  /** Set when the sender is (or linked to) a registered Orca account. */
  orcaUsername?: string;
  /** Full-access (all-access policy) turn — unlocks project-scoped power tools. NOT sufficient for
   *  owner-only surfaces: a foreign platform member mapped to an admin role also lands here. */
  admin: boolean;
  /** The turn is genuinely the instance OPERATOR — their own chat, their linked platform account, or
   *  their own automation (cron). Owner-only surfaces (private long-term memory, the raw Discord API)
   *  gate on THIS, never on `admin`, so an admin-role stranger can't reach the operator's private state. */
  owner: boolean;
}

/** Per-turn tool access — the SINGLE abstraction both sources (a user's Orca account and a platform
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

interface TurnScope { policy: Policy; identity?: TurnIdentity; elicit?: Elicitor; emitCard?: CardEmitter; toolPolicy?: ToolPolicy }

/** pi tools have no per-call session context, so a plugin tool can't be told which user's policy applies
 *  through its arguments. We carry the resolved Policy (+ the sender's identity + their effective tool
 *  access) on an AsyncLocalStorage (the Node equivalent of Hermes' security contextvar): BrainService
 *  runs each prompt inside `runWithPolicy`, and a plugin tool reads `currentPolicy()`/`currentIdentity()`/
 *  `currentToolPolicy()` at execution time. */
const store = new AsyncLocalStorage<TurnScope>();

/** Run `fn` (a brain prompt turn) with `policy` established for any plugin tool it invokes. `opts`
 *  carries the sender's identity, a turn-bound elicitor/card-emitter, and the effective tool policy —
 *  all read at tool-execute time via the `current*()` accessors. */
export function runWithPolicy<T>(policy: Policy, fn: () => T, opts?: { identity?: TurnIdentity; elicit?: Elicitor; emitCard?: CardEmitter; toolPolicy?: ToolPolicy }): T {
  return store.run({ policy, identity: opts?.identity, elicit: opts?.elicit, emitCard: opts?.emitCard, toolPolicy: opts?.toolPolicy }, fn);
}

/** The Policy in effect for the current prompt turn, or undefined outside a `runWithPolicy` scope. */
export function currentPolicy(): Policy | undefined {
  return store.getStore()?.policy;
}

/** The sender identity of the current prompt turn, or null when none was established. */
export function currentIdentity(): TurnIdentity | null {
  return store.getStore()?.identity ?? null;
}

/** The effective tool policy for the current turn (used by the plugin-tool execute-time gate), or
 *  undefined when none was established (→ every plugin tool permitted). */
export function currentToolPolicy(): ToolPolicy | undefined {
  return store.getStore()?.toolPolicy;
}

/** The turn-bound elicitor for `ctx.askUser`, or null outside a prompt turn (or when the transport
 *  driving the turn wired none — e.g. non-interactive worker sessions). */
export function currentElicitor(): Elicitor | null {
  return store.getStore()?.elicit ?? null;
}

/** The turn-bound card emitter for `ctx.emitCard`, or null outside a prompt turn (or a transport that
 *  wired none). */
export function currentCardEmitter(): CardEmitter | null {
  return store.getStore()?.emitCard ?? null;
}
