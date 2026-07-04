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

interface TurnScope { policy: Policy; identity?: TurnIdentity; elicit?: Elicitor; emitCard?: CardEmitter }

/** pi tools have no per-call session context, so a plugin tool can't be told which user's policy applies
 *  through its arguments. We carry the resolved Policy (+ the sender's identity) on an AsyncLocalStorage
 *  (the Node equivalent of Hermes' security contextvar): BrainService runs each prompt inside
 *  `runWithPolicy`, and a plugin tool reads `currentPolicy()`/`currentIdentity()` at execution time. */
const store = new AsyncLocalStorage<TurnScope>();

/** Run `fn` (a brain prompt turn) with `policy` (and optionally the sender's identity + a turn-bound
 *  elicitor for `ctx.askUser`) established for any plugin tool it invokes. */
export function runWithPolicy<T>(policy: Policy, fn: () => T, identity?: TurnIdentity, elicit?: Elicitor, emitCard?: CardEmitter): T {
  return store.run({ policy, identity, elicit, emitCard }, fn);
}

/** The Policy in effect for the current prompt turn, or undefined outside a `runWithPolicy` scope. */
export function currentPolicy(): Policy | undefined {
  return store.getStore()?.policy;
}

/** The sender identity of the current prompt turn, or null when none was established. */
export function currentIdentity(): TurnIdentity | null {
  return store.getStore()?.identity ?? null;
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
