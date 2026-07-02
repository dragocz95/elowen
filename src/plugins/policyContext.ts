import { AsyncLocalStorage } from 'node:async_hooks';
import type { Policy } from './policy.js';

/** Who is driving the current prompt turn. Plugins that persist per-user state (long-term memory)
 *  key it on this: a linked platform sender resolves to their Orca username, an unknown sender to
 *  `<platform>:<platformUserId>`, the owner to whatever identity the plugin's config anchors. */
export interface TurnIdentity {
  platform: string;
  userId: string;
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

interface TurnScope { policy: Policy; identity?: TurnIdentity }

/** pi tools have no per-call session context, so a plugin tool can't be told which user's policy applies
 *  through its arguments. We carry the resolved Policy (+ the sender's identity) on an AsyncLocalStorage
 *  (the Node equivalent of Hermes' security contextvar): BrainService runs each prompt inside
 *  `runWithPolicy`, and a plugin tool reads `currentPolicy()`/`currentIdentity()` at execution time. */
const store = new AsyncLocalStorage<TurnScope>();

/** Run `fn` (a brain prompt turn) with `policy` (and optionally the sender's identity) established for
 *  any plugin tool it invokes. */
export function runWithPolicy<T>(policy: Policy, fn: () => T, identity?: TurnIdentity): T {
  return store.run({ policy, identity }, fn);
}

/** The Policy in effect for the current prompt turn, or undefined outside a `runWithPolicy` scope. */
export function currentPolicy(): Policy | undefined {
  return store.getStore()?.policy;
}

/** The sender identity of the current prompt turn, or null when none was established. */
export function currentIdentity(): TurnIdentity | null {
  return store.getStore()?.identity ?? null;
}
