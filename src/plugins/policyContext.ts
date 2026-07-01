import { AsyncLocalStorage } from 'node:async_hooks';
import type { Policy } from './policy.js';

/** pi tools have no per-call session context, so a plugin tool can't be told which user's policy applies
 *  through its arguments. We carry the resolved Policy on an AsyncLocalStorage (the Node equivalent of
 *  Hermes' security contextvar): BrainService runs each prompt inside `runWithPolicy`, and a plugin tool
 *  reads `currentPolicy()` at execution time. */
const store = new AsyncLocalStorage<Policy>();

/** Run `fn` (a brain prompt turn) with `policy` established for any plugin tool it invokes. */
export function runWithPolicy<T>(policy: Policy, fn: () => T): T {
  return store.run(policy, fn);
}

/** The Policy in effect for the current prompt turn, or undefined outside a `runWithPolicy` scope. */
export function currentPolicy(): Policy | undefined {
  return store.getStore();
}
