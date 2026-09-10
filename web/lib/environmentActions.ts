'use client';
import type { EnvironmentAction, EnvironmentOperation } from '../../src/shared/wireContract';
import { BASE, ElowenApiError } from './elowenClient';

/** Ask the sandbox plugin for one environment lifecycle operation and get the durable row back.
 *
 *  The plugin's own route, the same generation precondition its drawer sends: `expectedGeneration` is the
 *  generation this screen last saw, so a request composed against an environment that has moved since is
 *  refused rather than applied to the new one. That precondition used to be sent by the drawer alone.
 *
 *  What a core screen does NOT carry is the drawer's persisted idempotency key — it retries an intent it
 *  is watching, and the runtime answers such a retry with the identical operation while that action is
 *  still active — so the two bodies are not byte-for-byte equal. The unused `requestId` parameter this
 *  helper used to accept was exactly that gap pretending to be closed. */
export async function requestEnvironmentAction(
  projectId: number,
  action: EnvironmentAction,
  expectedGeneration?: number,
): Promise<EnvironmentOperation> {
  const response = await fetch(`${BASE}/plugins/sandbox/api/projects/${projectId}/environment`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...(expectedGeneration === undefined ? {} : { expectedGeneration }) }),
  });
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) {
    throw new ElowenApiError(`environment ${action.kind} refused (${response.status})`, response.status,
      typeof body?.error === 'string' ? body.error : undefined, body);
  }
  return body as unknown as EnvironmentOperation;
}

/** Whether a failure is the stale-container case the explicit recreate exists to repair. The daemon
 *  names it in the error it stores, so no surface has to infer it from a state word.
 *
 *  The ONE reading of that message: core screens call it, and it is handed to plugin bundles through the
 *  UI runtime's `utils` so a bundle offers the same repair for the same error. Two copies of the pattern
 *  — one here and one in a bundle — meant rewording the daemon's message could offer the repair on one
 *  screen and not another. */
export function recreatable(error: string | null | undefined): boolean {
  return /predates the named project mount/i.test(error ?? '');
}
